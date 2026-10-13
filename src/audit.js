import { nowIso } from './db.js';
import { newAuditId } from './ids.js';

// Ids, counts, verbs, outcomes. There is no text column on audit_log, so
// there is structurally nothing here that could carry the customer's business.
export function audit(db, { tenant_id, verb, actor_key_id = null, source_id = null,
                            document_count = null, outcome }) {
  db.prepare(`INSERT INTO audit_log
              (id, tenant_id, at, verb, actor_key_id, source_id, document_count, outcome)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newAuditId(), tenant_id, nowIso(), verb, actor_key_id, source_id, document_count, outcome);
}
