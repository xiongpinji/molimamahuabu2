'use strict';

const path = require('node:path');
const { getExecutionQueue } = require('./redrawExecutionQueueService');
const { getLocalizationReview } = require('./localizationService');
const { compileUnitProductionPack } = require('./redrawUnitProductionPackService');
const { hashPlanValue } = require('./redrawExecutionPlanService');
const { withSourceVideoSnapshot } = require('./redrawSourceVideoService');
const { prepareMotionReferenceCandidate } = require('./redrawReferenceArtifactImportService');
const { readParentReferenceMaterials } = require('./redrawReferenceBundleService');
const { assertStoredProcessingMaterial } = require('./redrawMotionProcessingReportService');

const FIELDS = ['version_id', 'review_id', 'queue_id', 'plan_hash', 'unit_id', 'unit_hash'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = (kind = 'STALE') => { throw Object.assign(new Error(`REDRAW_UNIT_REFERENCE_MATERIALS_${kind}`),
  { code: `REDRAW_UNIT_REFERENCE_MATERIALS_${kind}` }); };

function currentPack(ctx, expected) {
  const version = ctx.db.prepare(`SELECT v.* FROM redraw_versions v JOIN redraw_works w ON w.id = v.work_id
    AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id WHERE v.id = ? AND v.tenant_id = ?
    AND v.user_id = ? AND v.deleted_at IS NULL AND w.deleted_at IS NULL`).get(expected.version_id, ctx.tenantId, ctx.userId);
  if (!version) fail();
  // Match the preview's version-pinned revision, never the work's latest draft.
  const row = ctx.db.prepare(`SELECT blueprint_json, blueprint_hash, status FROM redraw_episode_blueprints
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND revision = ? ORDER BY id DESC LIMIT 1`)
    .get(version.work_id, ctx.tenantId, ctx.userId, version.version);
  if (!row || row.status !== 'locked' || row.blueprint_hash !== version.blueprint_hash) fail();
  let blueprint;
  try { blueprint = JSON.parse(row.blueprint_json); } catch { fail(); }
  const localization = getLocalizationReview(ctx.db, ctx, version.id).localization;
  return compileUnitProductionPack({ owner: { tenantId: ctx.tenantId, userId: ctx.userId,
    workId: version.work_id, versionId: version.id }, expected,
  queueState: getExecutionQueue(ctx, version.id), blueprint, localization });
}

function parentShot(ctx, pack, parent) {
  const matches = ctx.db.prepare(`SELECT * FROM redraw_shots WHERE tenant_id = ? AND user_id = ?
    AND version_id = ? AND shot_id = ? AND deleted_at IS NULL`)
    .all(ctx.tenantId, ctx.userId, pack.bindings.version_id, parent.parent_shot_id);
  if (matches.length !== 1) fail();
  const shot = matches[0];
  if (Number(shot.work_id) !== pack.bindings.work_id || shot.start_ms !== parent.parent_start_ms
    || shot.end_ms !== parent.parent_end_ms || shot.duration_ms !== parent.parent_end_ms - parent.parent_start_ms) fail();
  return shot;
}

function candidateRow(ctx, shotId) {
  const candidate = ctx.db.prepare(`SELECT i.* FROM redraw_reference_artifact_imports i
    WHERE i.tenant_id = ? AND i.user_id = ? AND i.version_id = ? AND i.scope_type = 'shot'
      AND i.scope_id = ? AND i.purpose = 'motion' AND i.status = 'completed' ORDER BY i.id DESC LIMIT 1`)
    .get(ctx.tenantId, ctx.userId, ctx.versionId, shotId);
  if (!candidate) return candidate;
  // Keep both complete rows: a flat join would hide the import's id behind the asset's id.
  return { ...candidate, asset: ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(candidate.stored_asset_id) };
}

function parentResult(parent, shot, materials) {
  return { parent_shot_id: parent.parent_shot_id, shot_id: shot.id, parent_contract_hash: parent.parent_contract_hash,
    parent_range: { start_ms: parent.parent_start_ms, end_ms: parent.parent_end_ms },
    source_range: { start_ms: parent.source_start_ms, end_ms: parent.source_end_ms },
    parent_offsets: { start_ms: parent.source_start_ms - parent.parent_start_ms,
      end_ms: parent.source_end_ms - parent.parent_start_ms },
    dependencies: { ...materials.fingerprints,
      identities: materials.identities.map(identity => ({ source_character_key: identity.source_character_key,
        redraw_asset_id: identity.redraw_asset_id, asset_id: identity.identity_asset_id, sha256: identity.artifact.sha256,
        identity_pack_sha256: identity.identity_pack_sha256,
        wardrobe: { asset_id: identity.wardrobe.reference_asset_id, sha256: identity.wardrobe.reference_sha256 } })),
      text_clean: materials.text_clean.map(clean => ({ region_key: clean.region_key, kind: clean.kind,
        redraw_asset_id: clean.redraw_asset_id, asset_id: Number(clean.artifact.asset_id),
        sha256: clean.artifact.sha256, pack_sha256: clean.pack_sha256 })),
    } };
}

// Server-only live leases remain inside the source callback; finish is synchronous.
async function withUnitReferenceMaterials(rawCtx, input, consume, finish) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(input, key))
    || !['version_id', 'review_id', 'queue_id'].every(key => positive(input[key]))
    || !sha(input.plan_hash) || !sha(input.unit_hash) || typeof input.unit_id !== 'string' || !input.unit_id.trim()
    || !rawCtx?.db || typeof rawCtx.db.prepare !== 'function'
    || typeof rawCtx.tenantId !== 'string' || !rawCtx.tenantId.trim()
    || typeof rawCtx.userId !== 'string' || !rawCtx.userId.trim()
    || !path.isAbsolute(String(rawCtx.storageRoot || ''))
    || (rawCtx.versionId != null && rawCtx.versionId !== input.version_id)) fail('INVALID');
  const expected = { ...input };
  const ctx = { ...rawCtx, versionId: expected.version_id };
  const pack = currentPack(ctx, expected);
  const handles = [];
  const checked = [];
  const referenceById = new Map();
  const assertCurrent = () => {
    ctx.signal?.throwIfAborted();
    if (currentPack(ctx, expected).production_pack_hash !== pack.production_pack_hash) fail();
    for (const entry of checked) {
      entry.assertCurrentRecordBinding();
      if (hashPlanValue(parentShot(ctx, pack, entry.parent)) !== entry.shot_hash
        || hashPlanValue(candidateRow(ctx, entry.shot.id)) !== entry.candidate_hash) fail();
      entry.materials.assertCurrentBinding();
    }
  };
  let result;
  let primaryError;
  try {
    result = await withSourceVideoSnapshot(ctx, { tenantId: ctx.tenantId, userId: ctx.userId,
      workId: pack.bindings.work_id, expectedSourceAssetId: pack.bindings.source_asset_id,
      expectedSourceSha256: pack.bindings.source_sha256 }, async source => {
      for (const parent of pack.parent_contexts) {
        assertCurrent(); source.assertCurrentBinding();
        const shot = parentShot(ctx, pack, parent);
        const handle = await prepareMotionReferenceCandidate(ctx, { tenantId: ctx.tenantId, userId: ctx.userId,
          shotId: shot.id, expectedUpdatedAt: shot.updated_at, expectedSourceSha256: pack.bindings.source_sha256 });
        handles.push(handle); handle.assertCurrentBinding();
        if (handle.data.status !== 'available') fail();
        const candidate = candidateRow(ctx, shot.id);
        if (!candidate?.asset || candidate.id !== handle.data.candidate.import_id
          || candidate.stored_asset_id !== handle.data.candidate.asset.id) fail();
        const materials = await readParentReferenceMaterials(ctx, { shot_id: shot.id,
          motion_reference_asset_id: candidate.stored_asset_id });
        handle.assertCurrentBinding();
        const metadata = JSON.parse(candidate.asset.metadata);
        if (Object.hasOwn(metadata, 'redraw_motion_processing')) {
          await assertStoredProcessingMaterial(ctx, { shot_id: shot.id, expected_updated_at: shot.updated_at },
            metadata.redraw_motion_processing, metadata.redraw_motion_import);
          handle.assertCurrentBinding();
        }
        if (materials.source.work_id !== pack.bindings.work_id
          || String(materials.source.asset_id) !== String(pack.bindings.source_asset_id)
          || materials.source.fingerprint !== pack.bindings.source_sha256) fail();
        const keys = [...new Set(materials.identities.map(identity => identity.source_character_key))].sort();
        if (hashPlanValue(keys) !== hashPlanValue([...parent.visible_character_ids].sort())) fail();
        for (const identity of materials.identities) {
          if (identity.target_character_name !== pack.character_name_map[identity.source_character_key]) fail();
          const id = `identity-${identity.source_character_key}`;
          const reference = { kind: 'image', asset_id: identity.identity_asset_id, sha256: identity.artifact.sha256,
            target_character_name: identity.target_character_name, identity_pack_sha256: identity.identity_pack_sha256,
            state: 'reusable' };
          if (referenceById.has(id) && hashPlanValue(referenceById.get(id)) !== hashPlanValue(reference)) fail();
          referenceById.set(id, reference);
        }
        const parentData = parentResult(parent, shot, materials);
        referenceById.set(`motion-${parent.parent_shot_id}`, { kind: 'video',
          asset_id: materials.motion.asset_id, sha256: materials.motion.sha256, asset_scope: 'original_parent',
          original_duration_ms: materials.motion.duration_ms, whole_parent_duration_tolerance_ms: 100,
          parent_shot_id: parent.parent_shot_id, parent_range: parentData.parent_range,
          source_range: parentData.source_range, parent_offsets: parentData.parent_offsets,
          state: parent.source_start_ms === parent.parent_start_ms && parent.source_end_ms === parent.parent_end_ms
            ? 'reusable' : 'needs_derivation' });
        checked.push({ parent, shot, materials, data: parentData, handle, candidate,
          assertCurrentRecordBinding: handle.assertCurrentRecordBinding,
          shot_hash: hashPlanValue(shot), candidate_hash: hashPlanValue(candidate) });
        assertCurrent(); source.assertCurrentBinding();
      }
      if (referenceById.size !== pack.reference_requirements.length) fail();
      const references = pack.reference_requirements.map(requirement => {
        const material = referenceById.get(requirement.id);
        if (!material || material.kind !== requirement.kind) fail();
        return { requirement_id: requirement.id, requirement_hash: requirement.requirement_hash, ...material };
      });
      const value = { schema_version: 'redraw-unit-reference-materials-v1',
        bindings: { ...pack.bindings, production_pack_hash: pack.production_pack_hash },
        references, parents: checked.map(entry => entry.data) };
      value.materials_hash = hashPlanValue(value);
      if (consume) await consume({ materials: value, parents: checked, source, assertCurrent });
      return value;
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    for (const handle of handles) {
      try { await handle.cleanup(); } catch (error) { cleanupError ??= error; }
    }
    if (!primaryError && cleanupError) throw cleanupError;
  }
  // No await after this check. Candidate/source handles have expired; reread real
  // current rows and bytes through the materials closures, not the expired handles.
  assertCurrent();
  return finish ? finish({ materials: result, productionPack: pack, assertCurrent }) : result;
}

module.exports = { withUnitReferenceMaterials, readCurrentUnitProductionPack: currentPack };
