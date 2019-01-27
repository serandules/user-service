var log = require('logger')('user-service');
var bodyParser = require('body-parser');
var dust = require('dustjs-linkedin');
var path = require('path');
var util = require('util');
var fs = require('fs');

var errors = require('errors');
var mongutils = require('mongutils');
var messenger = require('messenger');
var auth = require('auth');
var utils = require('utils');
var throttle = require('throttle');
var serandi = require('serandi');
var Users = require('model-users');
var Otps = require('model-otps');
var model = require('model');
var validators = require('./validators');

var template = function (name) {
  var data = fs.readFileSync(path.join(__dirname, 'templates', name + '.html'));
  dust.loadSource(dust.compile(String(data), 'service-users-' + name));
};

template('signup');

var xactions = {
  post: {
    recover: require('./xactions/recover')
  },
  put: {
    reset: require('./xactions/reset'),
    confirm: require('./xactions/confirm')
  }
};

// TODO: validate email address updates through PUT. i.e. switching to a new email address should re-validate the email for ownership
module.exports = function (router, done) {
  utils.group('public', function (err, pub) {
    if (err) {
      return done(err);
    }
    utils.group('anonymous', function (err, anon) {
      if (err) {
        return done(err);
      }
      router.use(serandi.many);
      router.use(serandi.ctx);
      router.use(auth({
        GET: [
          '^\/$',
          '^\/.*'
        ],
        POST: [
          '^\/$',
          '^\/.*'
        ],
        PUT: [
          '^\/$',
          '^\/.*'
        ]
      }));
      router.use(throttle.apis('users'));
      router.use(bodyParser.json());

      router.post('/',
        serandi.json,
        serandi.xactions(xactions.post),
        serandi.captcha,
        serandi.create(Users),
        function (req, res, next) {
          model.create(req.ctx, function (err, user) {
            if (err) {
              if (err.code === mongutils.errors.DuplicateKey) {
                return next(errors.conflict());
              }
              return next(err);
            }
            utils.group('public', function (err, pub) {
              if (err) {
                return next(err);
              }
              utils.group('anonymous', function (err, anon) {
                if (err) {
                  return next(err);
                }
                var usr = user.toJSON();

                utils.permit(usr, 'user', usr.id, ['read', 'update', 'delete']);
                utils.permit(usr, 'group', pub.id, 'read');
                utils.permit(usr, 'group', anon.id, 'read');

                utils.visible(usr, 'users', usr.id, '*');
                utils.visible(usr, 'groups', pub.id, 'alias');
                utils.visible(usr, 'groups', anon.id, 'alias');

                Users.findOneAndUpdate({_id: usr.id}, {
                  permissions: usr.permissions,
                  visibility: usr.visibility,
                  _: {
                    blocked: true
                  }
                }).exec(function (err) {
                  if (err) {
                    return next(err);
                  }
                  model.create({
                    user: user,
                    model: Otps,
                    data: {
                      name: 'accounts-confirm'
                    }
                  }, function (err, otp) {
                    if (err) {
                      return next(err);
                    }
                    var ctx = {
                      user: user,
                      title: 'Welcome to Serandives',
                      confirm: utils.resolve(util.format('accounts:///confirm?user=%s&email=%s&otp=%s', user.id, user.email, otp.value))
                    };
                    dust.render('service-users-signup', ctx, function (err, html) {
                      if (err) {
                        return next(err);
                      }
                      messenger.email({
                        from: 'Serandives <no-reply@serandives.com>',
                        to: user.email,
                        subject: ctx.title,
                        html: html,
                        text: html
                      }, function (err) {
                        if (err) {
                          return next(err);
                        }
                        res.locate(user.id).status(201).send(user);
                      });
                    });
                  });
                });
              });
            });
          });
        });

      router.get('/:id',
        serandi.findOne(Users),
        function (req, res, next) {
          model.findOne(req.ctx, function (err, user) {
            if (err) {
              return next(err);
            }
            var name;
            var opts = [];
            for (name in user.addresses) {
              if (user.addresses.hasOwnProperty(name)) {
                opts.push({
                  model: 'Location',
                  path: 'addresses.' + name + '.location'
                });
              }
            }
            Users.populate(user, opts, function (err, user) {
              if (err) {
                return next(err);
              }
              res.send(user);
            });
          });
        });

      router.put('/:id',
        serandi.json,
        serandi.xactions(xactions.put),
        serandi.update(Users),
        validators.update,
        function (req, res, next) {
          model.update(req.ctx, function (err, user) {
            if (err) {
              return next(err);
            }
            res.locate(user.id).status(200).send(user);
          });
        });

      router.get('/',
        serandi.find(Users),
        function (req, res, next) {
          model.find(req.ctx, function (err, users, paging) {
            if (err) {
              return next(err);
            }
            res.many(users, paging);
          });
        });

      done();
    });
  });
};
