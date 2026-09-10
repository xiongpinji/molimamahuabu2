'use strict';
const { withUnitReferenceMaterials } = require('./redrawUnitReferenceMaterialsInternal');

async function inspectUnitReferenceMaterials(ctx, input) {
  return withUnitReferenceMaterials(ctx, input);
}

module.exports = { inspectUnitReferenceMaterials };
