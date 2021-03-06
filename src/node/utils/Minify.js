'use strict';

/**
 * This Module manages all /minified/* requests. It controls the
 * minification && compression of Javascript and CSS.
 */

/*
 * 2011 Peter 'Pita' Martischka (Primary Technology Ltd)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const settings = require('./Settings');
const fs = require('fs').promises;
const path = require('path');
const plugins = require('../../static/js/pluginfw/plugin_defs');
const RequireKernel = require('etherpad-require-kernel');
const mime = require('mime-types');
const Threads = require('threads');
const log4js = require('log4js');

const logger = log4js.getLogger('Minify');

const ROOT_DIR = path.normalize(`${__dirname}/../../static/`);

const threadsPool = new Threads.Pool(() => Threads.spawn(new Threads.Worker('./MinifyWorker')), 2);

const LIBRARY_WHITELIST = [
  'async',
  'js-cookie',
  'security',
  'tinycon',
  'underscore',
  'unorm',
];

// What follows is a terrible hack to avoid loop-back within the server.
// TODO: Serve files from another service, or directly from the file system.
const requestURI = async (url, method, headers) => await new Promise((resolve, reject) => {
  const parsedUrl = new URL(url);
  let status = 500;
  const content = [];
  const mockRequest = {
    url,
    method,
    params: {filename: (parsedUrl.pathname + parsedUrl.search).replace(/^\/static\//, '')},
    headers,
  };
  const mockResponse = {
    writeHead: (_status, _headers) => {
      status = _status;
      for (const header in _headers) {
        if (Object.prototype.hasOwnProperty.call(_headers, header)) {
          headers[header] = _headers[header];
        }
      }
    },
    setHeader: (header, value) => {
      headers[header.toLowerCase()] = value.toString();
    },
    header: (header, value) => {
      headers[header.toLowerCase()] = value.toString();
    },
    write: (_content) => {
      _content && content.push(_content);
    },
    end: (_content) => {
      _content && content.push(_content);
      resolve([status, headers, content.join('')]);
    },
  };
  minify(mockRequest, mockResponse).catch(reject);
});

const requestURIs = (locations, method, headers, callback) => {
  Promise.all(locations.map((loc) => requestURI(loc, method, headers))).then((responses) => {
    const statuss = responses.map((x) => x[0]);
    const headerss = responses.map((x) => x[1]);
    const contentss = responses.map((x) => x[2]);
    callback(statuss, headerss, contentss);
  });
};

/**
 * creates the minifed javascript for the given minified name
 * @param req the Express request
 * @param res the Express response
 */
const minify = async (req, res) => {
  let filename = req.params.filename;

  // No relative paths, especially if they may go up the file hierarchy.
  filename = path.normalize(path.join(ROOT_DIR, filename));
  filename = filename.replace(/\.\./g, '');

  if (filename.indexOf(ROOT_DIR) === 0) {
    filename = filename.slice(ROOT_DIR.length);
    filename = filename.replace(/\\/g, '/');
  } else {
    res.writeHead(404, {});
    res.end();
    return;
  }

  /* Handle static files for plugins/libraries:
     paths like "plugins/ep_myplugin/static/js/test.js"
     are rewritten into ROOT_PATH_OF_MYPLUGIN/static/js/test.js,
     commonly ETHERPAD_ROOT/node_modules/ep_myplugin/static/js/test.js
  */
  const match = filename.match(/^plugins\/([^/]+)(\/(?:(static\/.*)|.*))?$/);
  if (match) {
    const library = match[1];
    const libraryPath = match[2] || '';

    if (plugins.plugins[library] && match[3]) {
      const plugin = plugins.plugins[library];
      const pluginPath = plugin.package.realPath;
      filename = path.relative(ROOT_DIR, pluginPath + libraryPath);
      filename = filename.replace(/\\/g, '/'); // windows path fix
    } else if (LIBRARY_WHITELIST.indexOf(library) !== -1) {
      // Go straight into node_modules
      // Avoid `require.resolve()`, since 'mustache' and 'mustache/index.js'
      // would end up resolving to logically distinct resources.
      filename = `../node_modules/${library}${libraryPath}`;
    }
  }

  const contentType = mime.lookup(filename);

  const [date, exists] = await statFile(filename, 3);
  if (date) {
    date.setMilliseconds(0);
    res.setHeader('last-modified', date.toUTCString());
    res.setHeader('date', (new Date()).toUTCString());
    if (settings.maxAge !== undefined) {
      const expiresDate = new Date(Date.now() + settings.maxAge * 1000);
      res.setHeader('expires', expiresDate.toUTCString());
      res.setHeader('cache-control', `max-age=${settings.maxAge}`);
    }
  }

  if (!exists) {
    res.writeHead(404, {});
    res.end();
  } else if (new Date(req.headers['if-modified-since']) >= date) {
    res.writeHead(304, {});
    res.end();
  } else if (req.method === 'HEAD') {
    res.header('Content-Type', contentType);
    res.writeHead(200, {});
    res.end();
  } else if (req.method === 'GET') {
    const content = await getFileCompressed(filename, contentType);
    res.header('Content-Type', contentType);
    res.writeHead(200, {});
    res.write(content);
    res.end();
  } else {
    res.writeHead(405, {allow: 'HEAD, GET'});
    res.end();
  }
};

// find all includes in ace.js and embed them.
const getAceFile = async () => {
  let data = await fs.readFile(`${ROOT_DIR}js/ace.js`, 'utf8');

  // Find all includes in ace.js and embed them
  const filenames = [];
  if (settings.minify) {
    const regex = /\$\$INCLUDE_[a-zA-Z_]+\((['"])([^'"]*)\1\)/gi;
    // This logic can be simplified via String.prototype.matchAll() once support for Node.js
    // v11.x and older is dropped.
    let matches;
    while ((matches = regex.exec(data)) != null) {
      filenames.push(matches[2]);
    }
  }
  // Always include the require kernel.
  filenames.push('../static/js/require-kernel.js');

  data += ';\n';
  data += 'Ace2Editor.EMBEDED = Ace2Editor.EMBEDED || {};\n';

  // Request the contents of the included file on the server-side and write
  // them into the file.
  await Promise.all(filenames.map(async (filename) => {
    // Hostname "invalid.invalid" is a dummy value to allow parsing as a URI.
    const baseURI = 'http://invalid.invalid';
    let resourceURI = baseURI + path.normalize(path.join('/static/', filename));
    resourceURI = resourceURI.replace(/\\/g, '/'); // Windows (safe generally?)

    const [status, , body] = await requestURI(resourceURI, 'GET', {});
    const error = !(status === 200 || status === 404);
    if (!error) {
      data += `Ace2Editor.EMBEDED[${JSON.stringify(filename)}] = ${
        JSON.stringify(status === 200 ? body || '' : null)};\n`;
    } else {
      console.error(`getAceFile(): error getting ${resourceURI}. Status code: ${status}`);
    }
  }));
  return data;
};

// Check for the existance of the file and get the last modification date.
const statFile = async (filename, dirStatLimit) => {
  /*
   * The only external call to this function provides an explicit value for
   * dirStatLimit: this check could be removed.
   */
  if (typeof dirStatLimit === 'undefined') {
    dirStatLimit = 3;
  }

  if (dirStatLimit < 1 || filename === '' || filename === '/') {
    return [null, false];
  } else if (filename === 'js/ace.js') {
    // Sometimes static assets are inlined into this file, so we have to stat
    // everything.
    return [await lastModifiedDateOfEverything(), true];
  } else if (filename === 'js/require-kernel.js') {
    return [_requireLastModified, true];
  } else {
    let stats;
    try {
      stats = await fs.stat(ROOT_DIR + filename);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Stat the directory instead.
        const [date] = await statFile(path.dirname(filename), dirStatLimit - 1);
        return [date, false];
      }
      throw err;
    }
    return [stats.mtime, stats.isFile()];
  }
};

const lastModifiedDateOfEverything = async () => {
  const folders2check = [`${ROOT_DIR}js/`, `${ROOT_DIR}css/`];
  let latestModification = null;
  // go through this two folders
  await Promise.all(folders2check.map(async (path) => {
    // read the files in the folder
    const files = await fs.readdir(path);

    // we wanna check the directory itself for changes too
    files.push('.');

    // go through all files in this folder
    await Promise.all(files.map(async (filename) => {
      // get the stat data of this file
      const stats = await fs.stat(`${path}/${filename}`);

      // compare the modification time to the highest found
      if (latestModification == null || stats.mtime > latestModification) {
        latestModification = stats.mtime;
      }
    }));
  }));
  return latestModification;
};

// This should be provided by the module, but until then, just use startup
// time.
const _requireLastModified = new Date();
const requireDefinition = () => `var require = ${RequireKernel.kernelSource};\n`;

const getFileCompressed = async (filename, contentType) => {
  let content = await getFile(filename);
  if (!content || !settings.minify) {
    return content;
  } else if (contentType === 'application/javascript') {
    return await new Promise((resolve) => {
      threadsPool.queue(async ({compressJS}) => {
        try {
          logger.info('Compress JS file %s.', filename);

          content = content.toString();
          const compressResult = await compressJS(content);

          if (compressResult.error) {
            console.error(`Error compressing JS (${filename}) using terser`, compressResult.error);
          } else {
            content = compressResult.code.toString(); // Convert content obj code to string
          }
        } catch (error) {
          console.error('getFile() returned an error in ' +
                        `getFileCompressed(${filename}, ${contentType}): ${error}`);
        }
        resolve(content);
      });
    });
  } else if (contentType === 'text/css') {
    return await new Promise((resolve) => {
      threadsPool.queue(async ({compressCSS}) => {
        try {
          logger.info('Compress CSS file %s.', filename);

          content = await compressCSS(filename, ROOT_DIR);
        } catch (error) {
          console.error(`CleanCSS.minify() returned an error on ${filename}: ${error}`);
        }
        resolve(content);
      });
    });
  } else {
    return content;
  }
};

const getFile = async (filename) => {
  if (filename === 'js/ace.js') return await getAceFile();
  if (filename === 'js/require-kernel.js') return requireDefinition();
  return await fs.readFile(ROOT_DIR + filename);
};

exports.minify = (req, res, next) => minify(req, res).catch((err) => next(err || new Error(err)));

exports.requestURIs = requestURIs;

exports.shutdown = async (hookName, context) => {
  await threadsPool.terminate();
};
