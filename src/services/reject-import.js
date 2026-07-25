/**
 * Excel import for Data reject.xlsx — implement in Phase 1
 * Maps Excel columns -> reject_records + masters
 */
export function createRejectImportService(_pool) {
  return {
    async importFromBuffer(_buffer) {
      return { imported: 0, skipped: 0, errors: [] };
    },
  };
}
