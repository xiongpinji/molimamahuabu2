const reconciliation = require('./billingReconciliationService');

const CATEGORY_NAMES = [
  'safe_refund_candidate',
  'hold_for_provider_review',
  'missing_terminal_evidence',
  'completed_or_running_do_not_touch',
];

function uniqueStatuses(rows, field = 'status') {
  return [...new Set(rows
    .map((row) => String(row[field] || '').trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

function summarizeEvidence(evidence) {
  const tasks = evidence.tasks || [];
  const images = evidence.images || [];
  const videos = evidence.videos || [];
  const providerRoutes = evidence.providerRoutes || [];
  const providerAttempts = evidence.providerAttempts || [];
  return {
    async_tasks: {
      count: tasks.length,
      statuses: uniqueStatuses(tasks),
      has_provider_task_id: tasks.some((row) => Boolean(row.has_provider_task_id)),
    },
    image_generations: {
      count: images.length,
      statuses: uniqueStatuses(images),
    },
    video_generations: {
      count: videos.length,
      statuses: uniqueStatuses(videos),
      has_provider_task_id: videos.some((row) => Boolean(String(row.provider_task_id || '').trim())),
    },
    provider_routes: {
      count: providerRoutes.length,
      states: uniqueStatuses(providerRoutes, 'state'),
    },
    provider_route_attempts: {
      count: providerAttempts.length,
      states: uniqueStatuses(providerAttempts, 'state'),
      has_provider_task_id: providerAttempts.some((row) => Boolean(row.has_provider_task_id)),
    },
  };
}

function recommendationFor(row, evidence) {
  if (
    evidence.async_tasks.has_provider_task_id
    || evidence.video_generations.has_provider_task_id
    || evidence.provider_route_attempts.has_provider_task_id
  ) return 'hold_for_provider_review';
  if (row.safety_status === 'definite_failure') return 'safe_refund_candidate';
  if (row.safety_status === 'missing_terminal_evidence') return 'missing_terminal_evidence';
  if (['running', 'completed_requires_review'].includes(row.safety_status)) {
    return 'completed_or_running_do_not_touch';
  }
  return 'hold_for_provider_review';
}

function emptyCategories() {
  return Object.fromEntries(CATEGORY_NAMES.map((name) => [name, { records: 0, credits: 0 }]));
}

function buildDryRunReport(db, input = {}) {
  const rows = reconciliation.listAnomaliesReadOnly(db, input);
  const categories = emptyCategories();
  let totalCredits = 0;
  const items = rows.map((row) => {
    const evidence = summarizeEvidence(row.evidence || {});
    const recommendation = recommendationFor(row, evidence);
    const amount = Number(row.amount) || 0;
    totalCredits += amount;
    categories[recommendation].records += 1;
    categories[recommendation].credits += amount;
    return {
      reservation_id: row.reservation_id,
      scope: row.scope,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      amount,
      model: row.model,
      created_at: row.created_at,
      refundable: Boolean(row.refundable) && recommendation === 'safe_refund_candidate',
      safety_status: row.safety_status,
      recommendation,
      evidence,
    };
  });
  const generatedAt = input.now ? new Date(input.now) : new Date();
  return {
    generated_at: generatedAt.toISOString(),
    summary: {
      total_records: items.length,
      total_credits: totalCredits,
      categories,
    },
    items,
  };
}

module.exports = {
  buildDryRunReport,
};
