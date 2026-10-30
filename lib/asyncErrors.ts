// Express 4 ne capture pas les erreurs des routes async : une promesse rejetée faisait planter le serveur.
// On fait passer ces erreurs au gestionnaire d'erreurs d'Express (page 500) au lieu d'arrêter le processus.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Layer = require("express/lib/router/layer");

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req: any, res: any, next: any) {
  const fn = this.handle;
  if (fn.length > 3) return original.call(this, req, res, next);
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === "function") out.catch(next);
  } catch (err) {
    next(err);
  }
};

process.on("unhandledRejection", (reason) => console.error("[UNHANDLED]", reason));
