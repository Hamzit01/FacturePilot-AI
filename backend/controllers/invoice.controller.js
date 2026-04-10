'use strict';
/**
 * Exemple de contrôleur GET /api/invoices/:id
 * Démontre l'usage de requireAuth + requireOwner pour l'isolation tenant.
 *
 * Dans votre router :
 *
 *   const { requireAuth, requireOwner } = require('../middlewares/auth.middleware');
 *   const { getInvoice }               = require('../controllers/invoice.controller');
 *
 *   router.get('/:id', requireAuth, requireOwner('invoices'), getInvoice);
 */
const db = require('../db');

/**
 * GET /api/invoices/:id
 * req.resource est déjà chargé et vérifié par requireOwner.
 * Pas besoin de retoucher la DB — on retourne directement.
 */
const getInvoice = (req, res) => {
  // req.resource = ligne DB validée : { id, user_id, numero, ... }
  // user_id correspond à req.user.id (garanti par requireOwner)
  return res.json(req.resource);
};

/**
 * DELETE /api/invoices/:id
 * Montre comment faire une mutation après vérification IDOR.
 * requireOwner('invoices') doit précéder ce handler dans le router.
 */
const deleteInvoice = async (req, res) => {
  // req.resource.id est sûr : appartient à req.user.id
  const { id } = req.resource;

  // Double-vérification défensive dans la requête SQL — coût nul
  await db.query(
    'DELETE FROM invoices WHERE id = $1 AND user_id = $2',
    [id, req.user.id]
  );

  return res.status(204).end();
};

module.exports = { getInvoice, deleteInvoice };
