const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const scriptAnalysisRoutes = require('../src/routes/scriptAnalysis');
const aiClient = require('../src/services/aiClient');

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request({ id, userId = 'user-a', body = {} } = {}) {
  return {
    params: id === undefined ? {} : { id: String(id) },
    user: { id: userId },
    body,
  };
}

function validProductionPackage(overrides = {}) {
  return {
    schema_version: '1.0',
    source: {
      title: '测试剧本',
      source_script: '原始剧本',
      locked_facts: ['主角叫小满'],
    },
    normalized_script: {
      logline: '原始梗概',
      genre: '悬疑',
      tone: '紧张',
      target_duration_seconds: 60,
      story_structure: [],
    },
    character_bible: [],
    scene_bible: [],
    prop_bible: [],
    episodes: [{
      episode_number: 1,
      title: '第1集',
      scenes: [{
        scene_number: 1,
        shots: [{
          shot_number: 1,
          source_basis: ['原始剧本'],
          image_prompt: '雨夜街道',
          video_prompt: '镜头缓推',
          continuity: {},
          dialogue: [],
        }],
      }],
    }],
    continuity_rules: [],
    review: { status: 'needs_review', issues: [] },
    ai_changes: [],
    approval_status: 'needs_review',
    ...overrides,
  };
}

function validVisualDirection() {
  return {
    emotional_tone: {
      primary: '克制悬疑',
      secondary: '亲情压抑',
      evidence: ['雨夜街道'],
    },
    scene_profile: [{ type: '夜景外景', ratio_percent: 100, evidence: ['雨夜街道'] }],
    rhythm: { labels: ['缓慢铺垫'], evidence: ['小满走进雨夜街道'] },
    visual_motifs: [{ motif: '雨水反光', evidence: ['雨夜'], application: '贯穿场景' }],
    recommendations: [{
      rank: 1,
      name: '冷峻自然主义',
      objective_style: '低照度自然光与克制机位',
      match_reasons: ['符合雨夜氛围'],
      composition: '纵深构图',
      camera_movement: '缓慢推进',
      lighting: '冷暖对比',
      color: '低饱和蓝灰色',
      risks: [],
    }],
  };
}

test('剧本分析项目按用户隔离并可读取版本列表', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const handlers = scriptAnalysisRoutes(db, { error() {} });
    const created = captureResponse();
    handlers.create(request({
      body: {
        title: '雨夜追踪',
        source_script: '第一场：雨夜，女主进入旧仓库。',
        locked_facts: ['女主不能改名'],
      },
    }), created);

    assert.equal(created.statusCode, 201);
    assert.equal(created.body.success, true);
    assert.equal(created.body.data.status, 'draft');
    const projectId = created.body.data.id;

    const ownProject = captureResponse();
    handlers.get(request({ id: projectId }), ownProject);
    assert.equal(ownProject.statusCode, 200);
    assert.equal(ownProject.body.data.title, '雨夜追踪');

    const otherUser = captureResponse();
    handlers.get(request({ id: projectId, userId: 'user-b' }), otherUser);
    assert.equal(otherUser.statusCode, 404);

    const versions = captureResponse();
    handlers.versions(request({ id: projectId }), versions);
    assert.equal(versions.statusCode, 200);
    assert.deepEqual(versions.body.data, []);
  } finally {
    db.close();
  }
});

test('剧本分析在创建任务前拒绝未安装的 Skill', () => {
  const db = new Database(':memory:');
  const originalSetImmediate = global.setImmediate;
  try {
    runMigrationsAndEnsure(db);
    const handlers = scriptAnalysisRoutes(db, { error() {} });
    const created = captureResponse();
    handlers.create(request({
      body: {
        title: '非法 Skill 测试',
        source_script: '第一场：小满走进雨夜街道。',
        locked_facts: ['主角叫小满'],
      },
    }), created);

    global.setImmediate = () => ({ unref() {} });
    const response = captureResponse();
    handlers.run(request({
      id: created.body.data.id,
      body: { skill_id: 'not-installed' },
    }), response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.message, '所选剧本分析 Skill 不存在或不可用');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  } finally {
    global.setImmediate = originalSetImmediate;
    db.close();
  }
});

test('成功分析可选电影化视觉导演并保留原始剧本', async () => {
  const db = new Database(':memory:');
  const originalGenerateText = aiClient.generateText;
  const originalSetImmediate = global.setImmediate;
  try {
    runMigrationsAndEnsure(db);
    const handlers = scriptAnalysisRoutes(db, { error() {}, info() {} });
    const sourceScript = '第一场：小满走进雨夜街道。';
    const created = captureResponse();
    handlers.create(request({
      body: {
        title: '版本快照测试',
        source_script: sourceScript,
        locked_facts: ['主角叫小满'],
      },
    }), created);

    let backgroundTask = null;
    let capturedUserPrompt = '';
    aiClient.generateText = async (_db, _log, _type, userPrompt) => {
      capturedUserPrompt = userPrompt;
      return JSON.stringify(validProductionPackage({
        source: {
          title: '模型伪造标题',
          source_script: '模型改写原文',
          locked_facts: [],
        },
        visual_direction: validVisualDirection(),
      }));
    };
    global.setImmediate = (callback) => {
      backgroundTask = callback;
      return { unref() {} };
    };

    const response = captureResponse();
    handlers.run(request({
      id: created.body.data.id,
      body: { skill_id: 'cinematic-visual-director' },
    }), response);

    assert.equal(response.statusCode, 201);
    assert.equal(typeof backgroundTask, 'function');
    await backgroundTask();

    const version = db.prepare(`
      SELECT source_script, package_json
      FROM script_analysis_versions
      WHERE project_id = ? AND version = 1
    `).get(created.body.data.id);
    const project = db.prepare(`
      SELECT source_script, analysis_json
      FROM script_analysis_projects
      WHERE id = ?
    `).get(created.body.data.id);
    const productionPackage = JSON.parse(version.package_json);

    assert.equal(version.source_script, sourceScript);
    assert.equal(project.source_script, sourceScript);
    assert.equal(productionPackage.source.source_script, sourceScript);
    assert.deepEqual(productionPackage.source.locked_facts, ['主角叫小满']);
    assert.match(capturedUserPrompt, /"visual_direction"/);
    assert.deepEqual(productionPackage.visual_direction, validVisualDirection());
    assert.deepEqual(productionPackage.skill_snapshot, {
      id: 'cinematic-visual-director',
      name: '电影化视觉导演',
      version: '1.0.0',
      module: 'script_analysis',
      output_schema_version: '1.0',
    });
    assert.deepEqual(
      JSON.parse(project.analysis_json).skill_snapshot,
      productionPackage.skill_snapshot,
    );
  } finally {
    aiClient.generateText = originalGenerateText;
    global.setImmediate = originalSetImmediate;
    db.close();
  }
});

test('人工校订生成不可变新版本并拒绝过期或无效提交', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const handlers = scriptAnalysisRoutes(db, { error() {} });
    const now = new Date().toISOString();
    const originalSkillSnapshot = {
      id: 'cinematic-visual-director',
      name: '电影化视觉导演',
      version: '1.0.0',
      module: 'script_analysis',
      output_schema_version: '1.0',
    };
    const originalPackage = validProductionPackage({
      skill_snapshot: originalSkillSnapshot,
      visual_direction: validVisualDirection(),
    });
    const packageWithoutVisualDirection = { ...originalPackage };
    delete packageWithoutVisualDirection.visual_direction;
    const projectId = db.prepare(`
      INSERT INTO script_analysis_projects (
        user_id, title, source_script, locked_facts_json,
        analysis_json, review_json, status, current_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'needs_review', 1, ?, ?)
    `).run(
      'user-a',
      '校订测试',
      '第一场：小满走进雨夜街道。',
      JSON.stringify(['主角叫小满']),
      JSON.stringify(originalPackage),
      JSON.stringify(originalPackage.review),
      now,
      now,
    ).lastInsertRowid;
    db.prepare(`
      INSERT INTO script_analysis_versions (
        project_id, version, source_script, package_json,
        ai_changes_json, approval_status, created_at
      ) VALUES (?, 1, ?, ?, '[]', 'needs_review', ?)
    `).run(
      projectId,
      '第一场：小满走进雨夜街道。',
      JSON.stringify(originalPackage),
      now,
    );

    const revised = captureResponse();
    handlers.revise(request({
      id: projectId,
      body: {
        version: 1,
        note: '修正故事梗概',
        package: {
          ...packageWithoutVisualDirection,
          source: {
            title: '伪造标题',
            source_script: '被改写的原文',
            locked_facts: [],
          },
          normalized_script: {
            ...originalPackage.normalized_script,
            logline: '小满在雨夜追查失踪真相',
          },
          skill_snapshot: {
            ...originalSkillSnapshot,
            id: 'tampered-skill',
          },
        },
      },
    }), revised);
    assert.equal(revised.statusCode, 200);
    assert.equal(revised.body.data.current_version, 2);
    assert.equal(revised.body.data.status, 'needs_review');

    const versionRows = db.prepare(`
      SELECT version, package_json
      FROM script_analysis_versions
      WHERE project_id = ?
      ORDER BY version
    `).all(projectId);
    assert.equal(versionRows.length, 2);
    const versionOne = JSON.parse(versionRows[0].package_json);
    const versionTwo = JSON.parse(versionRows[1].package_json);
    assert.equal(versionOne.normalized_script.logline, '原始梗概');
    assert.equal(versionTwo.normalized_script.logline, '小满在雨夜追查失踪真相');
    assert.equal(versionTwo.source.source_script, '第一场：小满走进雨夜街道。');
    assert.deepEqual(versionTwo.source.locked_facts, ['主角叫小满']);
    assert.deepEqual(versionTwo.skill_snapshot, originalSkillSnapshot);
    assert.deepEqual(versionTwo.visual_direction, validVisualDirection());
    assert.equal(versionTwo.approval_status, 'needs_review');
    assert.equal(versionTwo.ai_changes.at(-1).source, 'human');
    assert.equal(versionTwo.ai_changes.at(-1).description, '修正故事梗概');

    const staleRevision = captureResponse();
    handlers.revise(request({
      id: projectId,
      body: {
        version: 1,
        note: '再次修改旧版本',
        package: originalPackage,
      },
    }), staleRevision);
    assert.equal(staleRevision.statusCode, 400);
    assert.equal(staleRevision.body.error.message, '只能校订当前版本');

    const invalidRevision = captureResponse();
    handlers.revise(request({
      id: projectId,
      body: {
        version: 2,
        note: '提交无效结构',
        package: validProductionPackage({ episodes: [] }),
      },
    }), invalidRevision);
    assert.equal(invalidRevision.statusCode, 400);
    assert.match(invalidRevision.body.error.message, /^校订后的生产包无效：/);

    const current = db.prepare(`
      SELECT current_version
      FROM script_analysis_projects
      WHERE id = ?
    `).get(projectId);
    assert.equal(current.current_version, 2);
  } finally {
    db.close();
  }
});
test('剧本分析只能审核当前版本并同步项目与版本状态', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const handlers = scriptAnalysisRoutes(db, { error() {} });
    const now = new Date().toISOString();
    const reviewPackage = {
      schema_version: '1.0',
      approval_status: 'needs_review',
      review: { status: 'needs_review' },
      source_basis: [{ source_text: '第一场', source_location: '第1场' }],
      story: { logline: '测试故事' },
      characters: [],
      scenes: [],
      props: [],
      storyboards: [{
        shot_no: 1,
        image_prompt: '雨夜仓库远景',
        video_prompt: '镜头缓慢推进',
      }],
      ai_changes: [],
    };
    const projectId = db.prepare(`
      INSERT INTO script_analysis_projects (
        user_id, title, source_script, locked_facts_json,
        analysis_json, review_json, status, current_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, '[]', ?, ?, 'needs_review', 2, ?, ?)
    `).run(
      'user-a',
      '审核测试',
      '第一场：雨夜仓库。',
      JSON.stringify(reviewPackage),
      JSON.stringify(reviewPackage.review),
      now,
      now,
    ).lastInsertRowid;
    db.prepare(`
      INSERT INTO script_analysis_versions (
        project_id, version, source_script, package_json,
        ai_changes_json, approval_status, created_at
      ) VALUES (?, 2, ?, ?, '[]', 'needs_review', ?)
    `).run(
      projectId,
      '第一场：雨夜仓库。',
      JSON.stringify(reviewPackage),
      now,
    );

    const staleReview = captureResponse();
    handlers.review(request({
      id: projectId,
      body: { version: 1, status: 'approved', note: '旧版本审核' },
    }), staleReview);
    assert.equal(staleReview.statusCode, 400);
    assert.equal(staleReview.body.error.message, '只能审核当前版本');

    const approved = captureResponse();
    handlers.review(request({
      id: projectId,
      body: { version: 2, status: 'approved', note: '人工复核通过' },
    }), approved);
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body.data.status, 'approved');
    assert.equal(approved.body.data.analysis_package.approval_status, 'approved');
    assert.equal(approved.body.data.review.review_note, '人工复核通过');

    const version = db.prepare(`
      SELECT approval_status, package_json
      FROM script_analysis_versions
      WHERE project_id = ? AND version = 2
    `).get(projectId);
    assert.equal(version.approval_status, 'approved');
    assert.equal(JSON.parse(version.package_json).approval_status, 'approved');
  } finally {
    db.close();
  }
});
