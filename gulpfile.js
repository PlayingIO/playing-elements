'use strict';

// Include Gulp & tools we'll use
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var del = require('del');
var runSequence = require('run-sequence');
var browserSync = require('browser-sync');
var reload = browserSync.reload;
var merge = require('merge-stream');
var path = require('path');
var fs = require('fs');
var glob = require('glob-all');
var historyApiFallback = require('connect-history-api-fallback');
var packageJson = require('./package.json');
var crypto = require('crypto');
var through = require('through2');
var mergeJson = require('gulp-merge-json');

var AUTOPREFIXER_BROWSERS = [
  'ie >= 10',
  'ie_mob >= 10',
  'ff >= 30',
  'chrome >= 34',
  'safari >= 7',
  'opera >= 23',
  'ios >= 7',
  'android >= 4.4',
  'bb >= 10'
];

var DIST = 'dist';

var dist = function(subpath) {
  return !subpath? DIST : path.join(DIST, subpath);
};

var styleTask = function(stylesPath, srcs) {
  return gulp.src(srcs.map(function(src) {
    return path.join(stylesPath, src);
  }))
    .pipe($.changed(stylesPath, {extension: '.css'}))
    .pipe($.autoprefixer(AUTOPREFIXER_BROWSERS))
    .pipe(gulp.dest('.tmp/' + stylesPath))
    .pipe($.minifyCss())
    .pipe(gulp.dest(dist(stylesPath)))
    .pipe($.size({title: stylesPath}));
};

var imageOptimizeTask = function(src, dest) {
  return gulp.src(src)
    .pipe($.imagemin({
      progressive: true,
      interlaced: true
    }))
    .pipe(gulp.dest(dest))
    .pipe($.size({title: 'images'}));
};

var optimizeHtmlTask = function(src, dest) {
  return gulp.src(src)
    // Replace path for vulcanized assets
    .pipe($.if('*.html', $.replace('elements/elements.html', 'elements.vulcanized.html')))
    // Concatenate and minify JavaScript
    .pipe($.if('*.js', $.uglify({
      preserveComments: 'some'
    })))
    // Concatenate and minify styles
    // In case you are still using useref build blocks
    .pipe($.if('*.css', $.minifyCss()))
    .pipe($.useref({
      searchPath: ['.tmp', '.', dist()]
    }))
    // Minify any HTML
    .pipe($.if('*.html', $.minifyHtml({
      quotes: true,
      empty: true,
      spare: true
    })))
    // Output files
    .pipe(gulp.dest(dest))
    .pipe($.size({
      title: 'html'
    }));
};

// Compile and automatically prefix stylesheets
gulp.task('styles', function() {
  return styleTask('styles', ['**/*.css']);
});

gulp.task('elements', function() {
  return styleTask('elements', ['**/*.css']);
});

// Lint JavaScript
gulp.task('lint', function() {
  return gulp.src([
    'elements/**/*.js',
    'elements/**/*.html',
    'gulpfile.js'
  ])
    .pipe(reload({
      stream: true,
      once: true
    }))
    .pipe($.eslint())
    .pipe($.eslint.format())
    .pipe($.if(!browserSync.active, $.eslint.failAfterError()));
});

// Optimize images
gulp.task('images', function() {
  return imageOptimizeTask('images/**/*', dist('images'));
});

// Copy all files at the root level (app)
gulp.task('copy', function() {
  var app = gulp.src([
    '*.{html,ico}',
    'manifest.json',
    'i18n/**/*',
    'themes/**/*'
  ], {
    dot: true,
    base: '.'
  }).pipe(gulp.dest(dist()));

  var bower = gulp.src([
    'bower_components/**/*'
  ]).pipe(gulp.dest(dist('bower_components')));

  var elements = gulp.src(['elements/**/*.html',
    'elements/**/*.css',
    'elements/**/*.js'
  ])
    .pipe(gulp.dest(dist()));

  var swBootstrap = gulp.src(['bower_components/platinum-sw/bootstrap/*.js'])
    .pipe(gulp.dest(dist('elements/bootstrap')));

  var swToolbox = gulp.src(['bower_components/sw-toolbox/*.js'])
    .pipe(gulp.dest(dist('sw-toolbox')));

  var vulcanized = gulp.src(['elements/elements.html'])
    .pipe($.rename('elements.vulcanized.html'))
    .pipe(gulp.dest(dist()));

  return merge(app, bower, elements, vulcanized, swBootstrap, swToolbox)
    .pipe($.size({
      title: 'copy'
    }));
});

// Scan your HTML for assets & optimize them
gulp.task('html', function() {
  return optimizeHtmlTask(
    ['index.html'],
    dist());
});

// merge message files from nuxeo-ui-elements and nuxeo-web-ui
// in case of conflict, nuxeo-web-ui prevails
gulp.task('merge-message-files', function() {
  var i18ndist = dist('i18n');
  var i18ntmp = '.tmp/i18n';
  return gulp.src(['bower_components/nuxeo-ui-elements/i18n/messages*.json'])
    .pipe($.if(function(file) {
      return fs.existsSync(path.join('i18n', path.basename(file.path)));
    }, through.obj(function(file, enc, callback) {
      gulp.src([file.path, path.join('i18n', path.basename(file.path))])
        .pipe(mergeJson(path.basename(file.path)))
        .pipe(gulp.dest(i18ntmp))
        .pipe(gulp.dest(i18ndist));
      callback();
    })))
    .pipe(gulp.dest(i18ntmp))
    .pipe(gulp.dest(i18ndist))
    .pipe($.size({title: 'merge-message-files'}));
});

// Vulcanize granular configuration
gulp.task('vulcanize', function() {
  return gulp.src(dist('elements.vulcanized.html'))
    .pipe($.vulcanize({
      stripComments: true,
      inlineCss: true,
      inlineScripts: true
    }))
    //.pipe($.minifyInline())
    .pipe(gulp.dest(dist()))
    .pipe($.size({title: 'vulcanize'}));
});

// Generate config data for the <sw-precache-cache> element.
// This include a list of files that should be precached, as well as a (hopefully unique) cache
// id that ensure that multiple PSK projects don't share the same Cache Storage.
// This task does not run by default, but if you are interested in using service worker caching
// in your project, please enable it within the 'default' task.
// See https://github.com/PolymerElements/polymer-starter-kit#enable-service-worker-support
// for more context.
gulp.task('cache-config', function(callback) {
  var dir = dist();
  var config = {
    cacheId: packageJson.name || path.basename(__dirname),
    disabled: false
  };

  glob([
    'index.html',
    './',
    'bower_components/webcomponentsjs/webcomponents-lite.min.js',
    '{elements,scripts,styles}/**/*.*'],
    {cwd: dir},
    function(error, files) {
      if (error) {
        callback(error);
      } else {
        config.precache = files;

        var md5 = crypto.createHash('md5');
        md5.update(JSON.stringify(config.precache));
        config.precacheFingerprint = md5.digest('hex');

        var configPath = path.join(dir, 'cache-config.json');
        fs.writeFile(configPath, JSON.stringify(config), callback);
      }
    });
});

// Clean output directory
gulp.task('clean', function() {
  return del(['.tmp', dist()]);
});

// Watch files for changes & reload
gulp.task('serve', ['lint', 'styles', 'elements', 'images', 'merge-message-files'], function() {
  // setup our local proxy
  var proxyOptions = require('url').parse('http://localhost:8080/nuxeo');
  proxyOptions.route = '/nuxeo';
  browserSync({
    browser: "google chrome",
    port: 5000,
    notify: false,
    logPrefix: 'PSK',
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function(snippet) {
          return snippet;
        }
      }
    },
    // Run as an https by uncommenting 'https: true'
    // Note: this uses an unsigned certificate which on first access
    //       will present a certificate warning in the browser.
    // https: true,
    server: {
      baseDir: ['.tmp', '.'],
      middleware: [require('proxy-middleware')(proxyOptions)]
    }
  });

  gulp.watch(['**/*.html'], reload);
  gulp.watch(['styles/**/*.css'], ['styles', reload]);
  gulp.watch(['elements/**/*.css'], ['elements', reload]);
  gulp.watch(['{scripts,elements}/**/{*.js,*.html}'], ['lint']);
  gulp.watch(['images/**/*'], reload);
  gulp.watch(['i18n/**/*'], ['merge-message-files', reload]);
});

// Build and serve the output from the dist build
gulp.task('serve:dist', ['default'], function() {
  browserSync({
    browser: "google chrome",
    port: 5001,
    notify: false,
    logPrefix: 'PSK',
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function(snippet) {
          return snippet;
        }
      }
    },
    // Run as an https by uncommenting 'https: true'
    // Note: this uses an unsigned certificate which on first access
    //       will present a certificate warning in the browser.
    // https: true,
    server: dist(),
    middleware: [historyApiFallback()]
  });
});

// Build production files, the default task
gulp.task('default', ['clean'], function(cb) {
  // Uncomment 'cache-config' if you are going to use service workers.
  runSequence(
    ['copy', 'styles'],
    'elements',
    ['lint', 'images', 'html', 'merge-message-files'],
    'vulcanize', // 'cache-config',
    cb);
});

// Build then deploy to GitHub pages gh-pages branch
gulp.task('build-deploy-gh-pages', function(cb) {
  runSequence(
    'default',
    'deploy-gh-pages',
    cb);
});

// Deploy to GitHub pages gh-pages branch
gulp.task('deploy-gh-pages', function() {
  return gulp.src([dist('**/*'), dist('**/.*')])
    .pipe($.ghPages());
});

// Load tasks for web-component-tester
// Adds tasks for `gulp test:local` and `gulp test:remote`
require('web-component-tester').gulp.init(gulp);

// Load custom tasks from the `tasks` directory
try {
  require('require-dir')('tasks');
} catch (err) {
  //
}
