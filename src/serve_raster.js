'use strict';

var async = require('async'),
    advancedPool = require('advanced-pool'),
    crypto = require('crypto'),
    fs = require('fs'),
    path = require('path'),
    util = require('util'),
    zlib = require('zlib');

var clone = require('clone'),
    express = require('express'),
    mercator = new (require('sphericalmercator'))(),
    mbgl = require('mapbox-gl-native'),
    mbtiles = require('mbtiles'),
    request = require('request'),
    sharp = require('sharp');

var utils = require('./utils');

var FLOAT_PATTERN = '[+-]?(?:\\d+|\\d+\.?\\d+)';
var SCALE_PATTERN = '@[23]x';

var getScale = function(scale) {
  return (scale || '@1x').slice(1, 2) | 0;
};

mbgl.on('message', function(e) {
  if (e.severity == 'WARNING' || e.severity == 'ERROR') {
    console.log('mbgl:', e);
  }
});

module.exports = function(maps, options, prefix) {
  var app = express().disable('x-powered-by'),
      domains = options.domains,
      tilePath = '/{z}/{x}/{y}.{format}';

  var rootPath = path.join(process.cwd(), options.root);

  var styleUrl = options.style;
  var map = {
    renderers: [],
    sources: {},
    tileJSON: {}
  };

  var styleJSON;
  var createPool = function(ratio, min, max) {
    var createRenderer = function(ratio, createCallback) {
      var renderer = new mbgl.Map({
        ratio: ratio,
        request: function(req, callback) {
          var protocol = req.url.split(':')[0];
          //console.log('Handling request:', req);
          if (protocol == req.url) {
            fs.readFile(path.join(rootPath, unescape(req.url)), function(err, data) {
              callback(err, { data: data });
            });
          } else if (protocol == 'mbtiles') {
            var parts = req.url.split('/');
            var source = map.sources[parts[2]];
            var z = parts[3] | 0,
                x = parts[4] | 0,
                y = parts[5].split('.')[0] | 0;
            source.getTile(z, x, y, function(err, data, headers) {
              if (err) {
                //console.log('MBTiles error, serving empty', err);
                callback(null, { data: new Buffer(0) });
              } else {
                var response = {};

                if (headers['Last-Modified']) {
                  response.modified = new Date(headers['Last-Modified']);
                }
                if (headers['ETag']) {
                  response.etag = headers['ETag'];
                }

                response.data = zlib.unzipSync(data);

                callback(null, response);
              }
            });
          } else if (protocol == 'http' || protocol == 'https') {
            request({
                url: req.url,
                encoding: null,
                gzip: true
            }, function(err, res, body) {
                if (err) {
                  //console.log('HTTP tile error', err);
                  callback(null, { data: new Buffer(0) });
                } else if (res.statusCode == 200) {
                  var response = {};

                  if (res.headers.modified) {
                    response.modified = new Date(res.headers.modified);
                  }
                  if (res.headers.expires) {
                    response.expires = new Date(res.headers.expires);
                  }
                  if (res.headers.etag) {
                    response.etag = res.headers.etag;
                  }

                  response.data = body;

                  callback(null, response);
                } else {
                  //console.log('HTTP error', JSON.parse(body).message);
                  callback(null, { data: new Buffer(0) });
                }
            });
          }
        }
      });
      renderer.load(styleJSON);
      createCallback(null, renderer);
    };
    return new advancedPool.Pool({
      min: min,
      max: max,
      create: createRenderer.bind(null, ratio),
      destroy: function(renderer) {
        renderer.release();
      }
    });
  };

  styleJSON = require(path.join(rootPath, styleUrl));

  map.tileJSON = {
    'tilejson': '2.0.0',
    'name': styleJSON.name,
    'basename': prefix.substr(1),
    'minzoom': 0,
    'maxzoom': 20,
    'bounds': [-180, -85.0511, 180, 85.0511],
    'format': 'png',
    'type': 'baselayer'
  };
  Object.assign(map.tileJSON, options.options || {});

  var queue = [];
  Object.keys(styleJSON.sources).forEach(function(name) {
    var source = styleJSON.sources[name];
    var url = source.url;
    if (url.lastIndexOf('mbtiles:', 0) === 0) {
      // found mbtiles source, replace with info from local file
      delete source.url;

      queue.push(function(callback) {
        var mbtilesUrl = url.substring('mbtiles://'.length);
        map.sources[name] = new mbtiles(path.join(rootPath, mbtilesUrl), function(err) {
          map.sources[name].getInfo(function(err, info) {
            Object.assign(source, info);
            source.basename = name;
            source.tiles = [
              // meta url which will be detected when requested
              'mbtiles://' + name + tilePath.replace('{format}', 'pbf')
            ];
            callback(null);
          });
        });
      });
    }
  });

  async.parallel(queue, function(err, results) {
    // TODO: make pool sizes configurable
    map.renderers[1] = createPool(1, 4, 16);
    map.renderers[2] = createPool(2, 2, 8);
    map.renderers[3] = createPool(3, 2, 4);
  });

  maps[prefix] = map;

  var tilePattern = tilePath
    .replace(/\.(?!.*\.)/, ':scale(' + SCALE_PATTERN + ')?.')
    .replace(/\./g, '\.')
    .replace('{z}', ':z(\\d+)')
    .replace('{x}', ':x(\\d+)')
    .replace('{y}', ':y(\\d+)')
    .replace('{format}', ':format([\\w\\.]+)');

  var respondImage = function(z, lon, lat, width, height, scale, format, res, next) {
    if (format == 'png' || format == 'webp') {
    } else if (format == 'jpg' || format == 'jpeg') {
      format = 'jpeg';
    } else {
      return res.status(404).send('Invalid format');
    }

    var pool = map.renderers[scale];
    pool.acquire(function(err, renderer) {
      var mbglZ = Math.max(0, z - 1);
      var params = {
        zoom: mbglZ,
        center: [lon, lat],
        width: width,
        height: height
      };
      if (z == 0) {
        params.width *= 2;
        params.height *= 2;
      }
      renderer.render(params, function(err, data) {
        pool.release(renderer);
        if (err) console.log(err);

        var image = sharp(data, {
          raw: {
            width: params.width * scale,
            height: params.height * scale,
            channels: 4
          }
        });

        if (z == 0) {
          // HACK: when serving zoom 0, resize the 0 tile from 512 to 256
          image.resize(width * scale, height * scale);
        }

        image.toFormat(format)
          .compressionLevel(9)
          .toBuffer(function(err, buffer, info) {
          if (!buffer) {
            return res.status(404).send('Not found');
          }

          var md5 = crypto.createHash('md5').update(buffer).digest('base64');
          res.set({
            'content-md5': md5,
            'content-type': 'image/' + format
          });
          return res.status(200).send(buffer);
        });
      });
    });
  };

  app.get(tilePattern, function(req, res, next) {
    var z = req.params.z | 0,
        x = req.params.x | 0,
        y = req.params.y | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;
    var tileSize = 256;
    var tileCenter = mercator.ll([
      ((x + 0.5) / (1 << z)) * (256 << z),
      ((y + 0.5) / (1 << z)) * (256 << z)
    ], z);
    return respondImage(z, tileCenter[0], tileCenter[1], tileSize, tileSize,
                        scale, format, res, next);
  });

  var staticPattern =
      '/static/%s:scale(' + SCALE_PATTERN + ')?\.:format([\\w\\.]+)';

  var centerPattern =
      util.format(':lon(%s),:lat(%s),:z(\\d+)/:width(\\d+)x:height(\\d+)',
                  FLOAT_PATTERN, FLOAT_PATTERN);

  app.get(util.format(staticPattern, centerPattern), function(req, res, next) {
    var z = req.params.z | 0,
        x = +req.params.lon,
        y = +req.params.lat,
        w = req.params.width | 0,
        h = req.params.height | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;
    return respondImage(z, x, y, w, h, scale, format, res, next);
  });

  var boundsPattern =
      util.format(':minx(%s),:miny(%s),:maxx(%s),:maxy(%s)/:z(\\d+)',
                  FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN);

  app.get(util.format(staticPattern, boundsPattern), function(req, res, next) {
    var z = req.params.z | 0,
        x = ((+req.params.minx) + (+req.params.maxx)) / 2,
        y = ((+req.params.miny) + (+req.params.maxy)) / 2,
        w = req.params.width | 0,
        h = req.params.height | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;
    return respondImage(z, x, y, w, h, scale, format, res, next);
  });

  app.get('/index.json', function(req, res, next) {
    var info = clone(map.tileJSON);

    info.tiles = utils.getTileUrls(req.protocol, domains, req.headers.host,
                                   prefix, tilePath, info.format,
                                   req.query.key);

    return res.send(info);
  });

  return app;
};