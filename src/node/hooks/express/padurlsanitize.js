'use strict';

const padManager = require('../../db/PadManager');
const url = require('url');

exports.expressCreateServer = (hookName, args, cb) => {
  // redirects browser to the pad's sanitized url if needed. otherwise, renders the html
  args.app.param('pad', async (req, res, next, padId) => {
    // ensure the padname is valid and the url doesn't end with a /
    if (!padManager.isValidPadId(padId) || /\/$/.test(req.url)) {
      res.status(404).send('Such a padname is forbidden');
      return;
    }

    const sanitizedPadId = await padManager.sanitizePadId(padId);

    if (sanitizedPadId === padId) {
      // the pad id was fine, so just render it
      next();
    } else {
      // the pad id was sanitized, so we redirect to the sanitized version
      let realURL = sanitizedPadId;
      realURL = encodeURIComponent(realURL);
      const query = url.parse(req.url).query;
      if (query) realURL += `?${query}`;
      res.header('Location', realURL);
      res.status(302).send(`You should be redirected to <a href="${realURL}">${realURL}</a>`);
    }
  });
  return cb();
};
