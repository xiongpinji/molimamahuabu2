'use strict';

const response = require('../response');
const {
  createTask,
  updateTaskStatus,
  updateTaskResult,
  updateTaskError,
} = require('../services/taskService');
const {
  getProjectInputError,
  normalizeProductionPackage,
  runAnalysis,
  validateProductionPackage,
} = require('../services/scriptAnalysisService');
const {
  listScriptAnalysisSkills,
  resolveScriptAnalysisSkill,
  snapshotScriptAnalysisSkill,
} = require('../services/scriptAnalysisSkillRegistry');

function parseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    source_script: row.source_script,
    locked_facts: parseJSON(row.locked_facts_json, []),
    analysis_package: parseJSON(row.analysis_json, null),
    review: parseJSON(row.review_json, null),
    status: row.status,
    current_version: row.current_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapVersion(row) {
  if (!row) return null;
  return {
    version: row.version,
    source_script: row.source_script,
    package: parseJSON(row.package_json, null),
    ai_changes: parseJSON(row.ai_changes_json, []),
    approval_status: row.approval_status,
    created_at: row.created_at,
  };
}

const REVIEW_STATUSES = new Set(['approved', 'rejected', 'needs_review']);

module.exports = function scriptAnalysisRoutes(db, log) {
  function userId(req) {
    return String(req.user?.id || 'local');
  }

  function findOwnedProject(id, ownerId) {
    return db.prepare(`
      SELECT *
      FROM script_analysis_projects
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(id, ownerId);
  }

  function list(req, res) {
    const rows = db.prepare(`
      SELECT *
      FROM script_analysis_projects
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(userId(req));
    return response.success(res, rows.map(mapProject));
  }

  function skills(req, res) {
    return response.success(res, { skills: listScriptAnalysisSkills() });
  }

  function get(req, res) {
    const row = findOwnedProject(req.params.id, userId(req));
    if (!row) return response.notFound(res, '剧本分析项目不存在');
    return response.success(res, mapProject(row));
  }

  function versions(req, res) {
    const project = findOwnedProject(req.params.id, userId(req));
    if (!project) return response.notFound(res, '剧本分析项目不存在');
    const rows = db.prepare(`
      SELECT version, source_script, package_json, ai_changes_json,
             approval_status, created_at
      FROM script_analysis_versions
      WHERE project_id = ?
      ORDER BY version DESC
    `).all(project.id);
    return response.success(res, rows.map(mapVersion));
  }

  function create(req, res) {
    const title = String(req.body?.title || '').trim();
    if (!title) return response.badRequest(res, '请输入项目标题');

    const now = new Date().toISOString();
    const sourceScript = String(req.body?.source_script || '');
    const lockedFacts = req.body?.locked_facts === undefined
      ? []
      : req.body.locked_facts;
    const inputError = getProjectInputError({ sourceScript, lockedFacts });
    if (inputError) return response.badRequest(res, inputError);

    const result = db.prepare(`
      INSERT INTO script_analysis_projects (
        user_id, title, source_script, locked_facts_json, status,
        current_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', 0, ?, ?)
    `).run(
      userId(req),
      title,
      sourceScript,
      JSON.stringify(lockedFacts),
      now,
      now,
    );
    return response.created(
      res,
      mapProject(findOwnedProject(result.lastInsertRowid, userId(req))),
    );
  }

  function update(req, res) {
    const ownerId = userId(req);
    const current = findOwnedProject(req.params.id, ownerId);
    if (!current) return response.notFound(res, '剧本分析项目不存在');

    const title = req.body?.title === undefined
      ? current.title
      : String(req.body.title || '').trim();
    if (!title) return response.badRequest(res, '请输入项目标题');

    const sourceScript = req.body?.source_script === undefined
      ? current.source_script
      : String(req.body.source_script || '');
    const lockedFacts = req.body?.locked_facts === undefined
      ? parseJSON(current.locked_facts_json, [])
      : req.body.locked_facts;
    const inputError = getProjectInputError({ sourceScript, lockedFacts });
    if (inputError) return response.badRequest(res, inputError);

    const currentLockedFacts = parseJSON(current.locked_facts_json, []);
    const sourceChanged = sourceScript !== current.source_script
      || JSON.stringify(lockedFacts) !== JSON.stringify(currentLockedFacts);
    const now = new Date().toISOString();
    if (sourceChanged) {
      db.prepare(`
        UPDATE script_analysis_projects
        SET title = ?, source_script = ?, locked_facts_json = ?,
            analysis_json = NULL, review_json = NULL,
            status = 'draft', updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        title,
        sourceScript,
        JSON.stringify(lockedFacts),
        now,
        current.id,
        ownerId,
      );
    } else {
      db.prepare(`
        UPDATE script_analysis_projects
        SET title = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(title, now, current.id, ownerId);
    }
    return response.success(res, mapProject(findOwnedProject(current.id, ownerId)));
  }

  function revise(req, res) {
    const ownerId = userId(req);
    const project = findOwnedProject(req.params.id, ownerId);
    if (!project) return response.notFound(res, '剧本分析项目不存在');

    const requestedVersion = Number(req.body?.version);
    if (!Number.isInteger(requestedVersion) || requestedVersion !== Number(project.current_version || 0)) {
      return response.badRequest(res, '只能校订当前版本');
    }

    const note = String(req.body?.note || '').trim();
    if (!note) return response.badRequest(res, '请填写人工校订说明');
    if (note.length > 2000) return response.badRequest(res, '人工校订说明不能超过 2000 字');

    const packageInput = req.body?.package;
    if (!packageInput || typeof packageInput !== 'object' || Array.isArray(packageInput)) {
      return response.badRequest(res, '请提交校订后的生产包');
    }
    if (!parseJSON(project.analysis_json, null) || !project.current_version) {
      return response.badRequest(res, '请先完成剧本分析再校订');
    }

    let normalizedPackage;
    try {
      normalizedPackage = validateProductionPackage(
        normalizeProductionPackage(packageInput, project),
      );
    } catch (error) {
      return response.badRequest(res, `校订后的生产包无效：${error.message}`);
    }

    const now = new Date().toISOString();
    const nextVersion = Number(project.current_version) + 1;
    const aiChanges = [
      ...(Array.isArray(normalizedPackage.ai_changes) ? normalizedPackage.ai_changes : []),
      {
        source: 'human',
        type: 'human_revision',
        description: note,
        created_at: now,
      },
    ];
    const reviewResult = {
      ...(normalizedPackage.review || {}),
      status: 'needs_review',
      revision_note: note,
      revised_at: now,
    };
    const revisedPackage = {
      ...normalizedPackage,
      version: nextVersion,
      approval_status: 'needs_review',
      ai_changes: aiChanges,
      review: reviewResult,
    };

    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO script_analysis_versions (
          project_id, version, source_script, package_json,
          ai_changes_json, approval_status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'needs_review', ?)
      `).run(
        project.id,
        nextVersion,
        project.source_script,
        JSON.stringify(revisedPackage),
        JSON.stringify(aiChanges),
        now,
      );
      db.prepare(`
        UPDATE script_analysis_projects
        SET analysis_json = ?, review_json = ?, status = 'needs_review',
            current_version = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        JSON.stringify(revisedPackage),
        JSON.stringify(reviewResult),
        nextVersion,
        now,
        project.id,
        ownerId,
      );
    });
    transaction();

    return response.success(res, mapProject(findOwnedProject(project.id, ownerId)));
  }

  function review(req, res) {
    const ownerId = userId(req);
    const project = findOwnedProject(req.params.id, ownerId);
    if (!project) return response.notFound(res, '剧本分析项目不存在');

    const status = String(req.body?.status || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!REVIEW_STATUSES.has(status)) {
      return response.badRequest(res, '审核状态无效');
    }
    const requestedVersion = Number(req.body?.version || project.current_version);
    if (requestedVersion !== Number(project.current_version)) {
      return response.badRequest(res, '只能审核当前版本');
    }
    if (note.length > 2000) {
      return response.badRequest(res, '审核说明不能超过 2000 字');
    }

    const productionPackage = parseJSON(project.analysis_json, null);
    if (!productionPackage || !project.current_version) {
      return response.badRequest(res, '请先完成剧本分析再审核');
    }

    const now = new Date().toISOString();
    const reviewResult = {
      ...(parseJSON(project.review_json, productionPackage.review || {})),
      status,
      review_note: note,
      reviewed_at: now,
    };
    const reviewedPackage = {
      ...productionPackage,
      approval_status: status,
      review: reviewResult,
    };
    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE script_analysis_projects
        SET analysis_json = ?, review_json = ?, status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        JSON.stringify(reviewedPackage),
        JSON.stringify(reviewResult),
        status,
        now,
        project.id,
        ownerId,
      );
      db.prepare(`
        UPDATE script_analysis_versions
        SET package_json = ?, approval_status = ?
        WHERE project_id = ? AND version = ?
      `).run(
        JSON.stringify(reviewedPackage),
        status,
        project.id,
        project.current_version,
      );
    });
    transaction();
    return response.success(res, mapProject(findOwnedProject(project.id, ownerId)));
  }

  function run(req, res) {
    const ownerId = userId(req);
    const project = findOwnedProject(req.params.id, ownerId);
    if (!project) return response.notFound(res, '剧本分析项目不存在');
    const selectedSkill = resolveScriptAnalysisSkill(req.body?.skill_id);
    if (!selectedSkill) {
      return response.badRequest(res, '所选剧本分析 Skill 不存在或不可用');
    }
    const inputError = getProjectInputError({
      sourceScript: project.source_script,
      lockedFacts: parseJSON(project.locked_facts_json, []),
    }, { requireSource: true });
    if (inputError) return response.badRequest(res, inputError);

    const task = createTask(db, log, 'script_analysis', `script-analysis:${project.id}`);
    db.prepare(`
      UPDATE async_tasks SET user_id = ? WHERE id = ?
    `).run(ownerId, task.id);
    db.prepare(`
      UPDATE script_analysis_projects
      SET status = 'analyzing', updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(new Date().toISOString(), project.id, ownerId);

    setImmediate(async () => {
      try {
        updateTaskStatus(db, task.id, 'processing', 5, '导演分析中');
        const productionPackage = await runAnalysis({
          db,
          log,
          project,
          skill: selectedSkill,
        });
        const reviewablePackage = {
          ...productionPackage,
          skill_snapshot: snapshotScriptAnalysisSkill(selectedSkill),
          approval_status: 'needs_review',
          review: {
            ...(productionPackage.review || {}),
            status: 'needs_review',
          },
        };
        updateTaskStatus(db, task.id, 'processing', 90, '保存生产包');

        const current = findOwnedProject(project.id, ownerId);
        const nextVersion = (current?.current_version || 0) + 1;
        const now = new Date().toISOString();
        const transaction = db.transaction(() => {
          db.prepare(`
            INSERT INTO script_analysis_versions (
              project_id, version, source_script, package_json,
              ai_changes_json, approval_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            project.id,
            nextVersion,
            project.source_script,
            JSON.stringify(reviewablePackage),
            JSON.stringify(reviewablePackage.ai_changes || []),
            'needs_review',
            now,
          );
          db.prepare(`
            UPDATE script_analysis_projects
            SET analysis_json = ?, review_json = ?, status = 'needs_review',
                current_version = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
          `).run(
            JSON.stringify(reviewablePackage),
            JSON.stringify(reviewablePackage.review || {}),
            nextVersion,
            now,
            project.id,
            ownerId,
          );
        });
        transaction();
        updateTaskResult(db, task.id, {
          project_id: project.id,
          version: nextVersion,
          package: reviewablePackage,
        });
      } catch (error) {
        log?.error?.({ err: error, projectId: project.id }, 'script analysis failed');
        db.prepare(`
          UPDATE script_analysis_projects
          SET status = 'failed', review_json = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(
          JSON.stringify({ status: 'failed', issues: [error.message] }),
          new Date().toISOString(),
          project.id,
          ownerId,
        );
        updateTaskError(db, task.id, error.message || '剧本分析失败');
      }
    });

    return response.created(res, {
      task_id: task.id,
      project_id: project.id,
      status: 'pending',
    });
  }

  return {
    skills,
    list,
    get,
    versions,
    create,
    update,
    revise,
    review,
    run,
  };
};
