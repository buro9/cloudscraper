var vm = require('vm');
var requestModule = require('request-promise');
var errors = require('./errors');

var USER_AGENTS = [
  'Ubuntu Chromium/34.0.1847.116 Chrome/34.0.1847.116 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.21 (KHTML, like Gecko) konqueror/4.14.10 Safari/537.21',
  'Mozilla/5.0 (iPad; CPU OS 5_1 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko ) Version/5.1 Mobile/9B176 Safari/7534.48.3',
  'Mozilla/5.0 (iPad; U; CPU OS 3_2 like Mac OS X; en-us) AppleWebKit/531.21.10 (KHTML, like Gecko) Version/4.0.4 Mobile/7B334b Safari/531.21.10',
  'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0; SLCC2; Media Center PC 6.0; InfoPath.3; MS-RTC LM 8; Zune 4.7)',
  'Mozilla/5.0 (Windows Phone 8.1; ARM; Trident/7.0; Touch; rv:11.0; IEMobile/11.0; NOKIA; Lumia 630) like Gecko',
  'Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0; ARM; Touch; NOKIA; Lumia 920)',
  'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Sprint APA9292KT Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:2.2a1pre) Gecko/20100101 Firefox/4.2a1pre',
  'Mozilla/5.0 (SymbianOS/9.1; U; en-us) AppleWebKit/413 (KHTML, like Gecko) Safari/413 es65',
  'Mozilla/5.0 (Linux; Android 6.0; Nexus 5X Build/MDB08L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.124 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; U; FreeBSD i386; de-CH; rv:1.9.2.8) Gecko/20100729 Firefox/3.6.8'
];

var DEFAULT_USER_AGENT = randomUA();

var VM_OPTIONS = {
  timeout: 5000
};

module.exports = defaults.call(requestModule);

function defaults (params) {
  // isCloudScraper === !isRequestModule
  var isRequestModule = this === requestModule;

  var defaultParams = (!isRequestModule && this.defaultParams) || {
    requester: requestModule,
    // Cookies should be enabled
    jar: requestModule.jar(),
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Cache-Control': 'private',
      'Accept': 'application/xml,application/xhtml+xml,text/html;q=0.9, text/plain;q=0.8,image/png,*/*;q=0.5'
    },
    // Cloudflare requires a delay of 5 seconds, so wait for at least 6.
    cloudflareTimeout: 6000,
    // followAllRedirects - follow non-GET HTTP 3xx responses as redirects
    followAllRedirects: true,
    // Support only this max challenges in row. If CF returns more, throw an error
    challengesToSolve: 3
  };

  // Object.assign requires at least nodejs v4, request only test/supports v6+
  defaultParams = Object.assign({}, defaultParams, params);

  var cloudscraper = requestModule.defaults
    .call(this, defaultParams, function (options) {
      return performRequest(options, true);
    });

  // There's no safety net here, any changes apply to all future requests
  // that are made with this instance and derived instances.
  cloudscraper.defaultParams = defaultParams;

  // Ensure this instance gets a copy of our custom defaults function
  // and afterwards, it will be copied over automatically.
  if (isRequestModule) {
    cloudscraper.defaults = defaults;
  }
  // Expose the debug option
  Object.defineProperty(cloudscraper, 'debug',
    Object.getOwnPropertyDescriptor(this, 'debug'));

  return cloudscraper;
}

// This function is wrapped to ensure that we get new options on first call.
// The options object is reused in subsequent calls when calling it directly.
function performRequest (options, isFirstRequest) {
  // Prevent overwriting realEncoding in subsequent calls
  if (!('realEncoding' in options)) {
    // Can't just do the normal options.encoding || 'utf8'
    // because null is a valid encoding.
    if ('encoding' in options) {
      options.realEncoding = options.encoding;
    } else {
      options.realEncoding = 'utf8';
    }
  }

  options.encoding = null;

  if (isNaN(options.challengesToSolve)) {
    throw new TypeError('Expected `challengesToSolve` option to be a number, ' +
      'got ' + typeof (options.challengesToSolve) + ' instead.');
  }

  // This should be the default export of either request or request-promise.
  var requester = options.requester;

  if (typeof requester !== 'function') {
    throw new TypeError('Expected `requester` option to be a function, got ' +
        typeof (requester) + ' instead.');
  }

  var request = requester(options);

  // If the requester is not request-promise, ensure we get a callback.
  if (typeof request.callback !== 'function') {
    throw new TypeError('Expected a callback function, got ' +
        typeof (request.callback) + ' instead.');
  }

  // We only need the callback from the first request.
  // The other callbacks can be safely ignored.
  if (isFirstRequest) {
    // This should be a user supplied callback or request-promise's callback.
    // The callback is always wrapped/bound to the request instance.
    options.callback = request.callback;
  }

  // The error event only provides an error argument.
  request.removeAllListeners('error')
    .once('error', processRequestResponse.bind(null, options));
  // The complete event only provides response and body arguments.
  request.removeAllListeners('complete')
    .once('complete', processRequestResponse.bind(null, options, null));

  // Indicate that this is a cloudscraper request, required by test/helper.
  request.cloudscraper = true;
  return request;
}

// The argument convention is options first where possible, options
// always before response, and body always after response.
function processRequestResponse (options, error, response, body) {
  var callback = options.callback;

  var stringBody;
  var isChallengePresent;
  var isRedirectChallengePresent;

  // Encoding is null so body should be a buffer object
  if (error || !body || !body.toString) {
    // Pure request error (bad connection, wrong url, etc)
    return callback(new errors.RequestError(error, options, response));
  }

  response.isCloudflare = response.statusCode > 499 &&
    /^cloudflare/i.test('' + response.caseless.get('server')) &&
    /text\/html/i.test('' + response.caseless.get('content-type'));

  if (response.isCloudflare) {
    if (body.length < 1) {
      // This is a 5xx Cloudflare response with an empty body.
      return callback(new errors.CloudflareError(response.statusCode, options, response));
    }

    stringBody = body.toString('utf8');

    try {
      validate(options, response, stringBody);
    } catch (error) {
      return callback(error);
    }
  }

  if (!response.isCloudflare || response.statusCode !== 503) {
    return processResponseBody(options, response, body);
  }

  // This is a Cloudflare response with 503 status, check for challenges.
  isChallengePresent = stringBody.indexOf('a = document.getElementById(\'jschl-answer\');') !== -1;
  isRedirectChallengePresent = stringBody.indexOf('You are being redirected') !== -1 || stringBody.indexOf('sucuri_cloudproxy_js') !== -1;
  // isTargetPage = !isChallengePresent && !isRedirectChallengePresent;

  if (isChallengePresent && options.challengesToSolve === 0) {
    var cause = 'Cloudflare challenge loop';
    error = new errors.CloudflareError(cause, options, response);
    error.errorType = 4;

    return callback(error);
  }

  // If body contains specified string, solve challenge
  if (isChallengePresent) {
    setTimeout(function () {
      solveChallenge(options, response, stringBody);
    }, options.cloudflareTimeout);
  } else if (isRedirectChallengePresent) {
    setCookieAndReload(options, response, stringBody);
  } else {
    // All is good
    processResponseBody(options, response, body);
  }
}

function validate (options, response, body) {
  var match;

  // Finding captcha
  if (body.indexOf('why_captcha') !== -1 || /cdn-cgi\/l\/chk_captcha/i.test(body)) {
    throw new errors.CaptchaError('captcha', options, response);
  }

  // Trying to find '<span class="cf-error-code">1006</span>'
  match = body.match(/<\w+\s+class="cf-error-code">(.*)<\/\w+>/i);

  if (match) {
    var code = parseInt(match[1]);
    throw new errors.CloudflareError(code, options, response);
  }

  return false;
}

function solveChallenge (options, response, body) {
  var callback = options.callback;

  var uri = response.request.uri;
  // The JS challenge to be evaluated for answer/response.
  var challenge;
  // The result of challenge being evaluated in sandbox
  var answer;
  // The query string to send back to Cloudflare
  // var payload = { jschl_vc, jschl_answer, pass };
  var payload = {};

  var match;
  var cause;

  match = body.match(/name="jschl_vc" value="(\w+)"/);

  if (!match) {
    cause = 'challengeId (jschl_vc) extraction failed';
    return callback(new errors.ParserError(cause, options, response));
  }

  payload.jschl_vc = match[1];

  match = body.match(/getElementById\('cf-content'\)[\s\S]+?setTimeout.+?\r?\n([\s\S]+?a\.value =.+?)\r?\n/i);

  if (!match) {
    cause = 'setTimeout callback extraction failed';
    return callback(new errors.ParserError(cause, options, response));
  }

  challenge = match[1]
    .replace(/a\.value =(.+?) \+ .+?;/i, '$1')
    .replace(/\s{3,}[a-z](?: = |\.).+/g, '')
    .replace(/'; \d+'/g, '');

  try {
    answer = vm.runInNewContext(challenge, undefined, VM_OPTIONS);
    payload.jschl_answer = answer + uri.hostname.length;
  } catch (error) {
    error.message = 'Challenge evaluation failed: ' + error.message;
    return callback(new errors.ParserError(error, options, response));
  }

  match = body.match(/name="pass" value="(.+?)"/);

  if (!match) {
    cause = 'Attribute (pass) value extraction failed';
    return callback(new errors.ParserError(cause, options, response));
  }

  payload.pass = match[1];

  // Prevent reusing the headers object to simplify unit testing.
  options.headers = Object.assign({}, options.headers);
  // Use the original uri as the referer and to construct the answer url.
  options.headers['Referer'] = uri.href;
  options.uri = uri.protocol + '//' + uri.hostname + '/cdn-cgi/l/chk_jschl';
  // Set the query string and decrement the number of challenges to solve.
  options.qs = payload;
  options.challengesToSolve = options.challengesToSolve - 1;

  // Make request with answer.
  performRequest(options, false);
}

function setCookieAndReload (options, response, body) {
  var callback = options.callback;

  var challenge = body.match(/S='([^']+)'/);
  if (!challenge) {
    var cause = 'Cookie code extraction failed';
    return callback(new errors.ParserError(cause, options, response));
  }

  var base64EncodedCode = challenge[1];
  var cookieSettingCode = Buffer.from(base64EncodedCode, 'base64').toString('ascii');

  var sandbox = {
    location: {
      reload: function () {}
    },
    document: {}
  };

  try {
    vm.runInNewContext(cookieSettingCode, sandbox, VM_OPTIONS);

    options.jar.setCookie(sandbox.document.cookie, response.request.uri.href, { ignoreError: true });
  } catch (error) {
    error.message = 'Cookie code evaluation failed: ' + error.message;
    return callback(new errors.ParserError(error, options, response));
  }

  options.challengesToSolve = options.challengesToSolve - 1;

  performRequest(options, false);
}

function processResponseBody (options, response, body) {
  var callback = options.callback;

  if (typeof options.realEncoding === 'string') {
    body = body.toString(options.realEncoding);
    // The resolveWithFullResponse option will resolve with the response
    // object. This changes the response.body so it is as expected.
    response.body = body;

    if (response.isCloudflare) {
      // In case of real encoding, try to validate the response and find
      // potential errors there, otherwise return the response as is.
      try {
        validate(options, response, body);
      } catch (error) {
        return callback(error);
      }
    }
  }

  callback(null, response, body);
}

function randomUA () {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
