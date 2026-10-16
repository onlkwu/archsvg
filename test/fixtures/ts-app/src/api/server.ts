import { Router } from 'express';
import { findUser } from '@db/user';

export function startServer(html: string) {
  const router = Router();
  router.get('/users/:id', async (req) => findUser(req.params.id).then((u) => ({ ...u, html })));
  return router;
}
