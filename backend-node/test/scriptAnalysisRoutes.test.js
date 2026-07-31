const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const scriptAnalysisRoutes = require('../src/routes/scriptAnalysis');

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
