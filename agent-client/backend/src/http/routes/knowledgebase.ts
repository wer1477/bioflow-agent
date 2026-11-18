import { Router, Request, Response } from 'express';
import { readKnowledgeBaseEntryForView } from '../../agent/core_tools/knowledgebase_executor.js';

/**
 * Read-only knowledge base viewer for the settings page.
 *
 * The disk tree is the source of truth (see `docs/knowledgebase-mechanism.md`); this
 * route only exposes an entry body and its resource metadata. It never writes, never
 * applies an agent scope and never returns resource bodies.
 */
const router = Router();

router.get('/entry', (req: Request, res: Response) => {
  const id = String(req.query.id || '');
  if (!id) {
    res.status(400).json({ ok: false, error: 'Query parameter "id" is required.' });
    return;
  }
  const result = readKnowledgeBaseEntryForView(id);
  if (!result.ok) {
    const status = result.reason === 'invalid_id' ? 400 : result.reason === 'malformed' ? 422 : 404;
    res.status(status).json(result);
    return;
  }
  res.json(result);
});

export default router;
