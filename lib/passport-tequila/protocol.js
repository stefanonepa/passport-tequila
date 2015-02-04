/**
 * API-neutral Tequila protocol implementation.
 *
 * Follows the terminology of [Lecommandeur-eunis-2005]; functions
 * are named after the URLs on the Tequila server (see also
 * [Lecommandeur-WritingClients]).
 *
 * [Lecommandeur-eunis-2005] Tequila. A distributed Web
 * authentication and access control tool, Claude Lecommandeur,
 * Ecole Polytechnique Fédérale de Lausanne, EUNIS 2005
 *
 * [Lecommandeur-WritingClients] Tequila: Writing Clients,
 * https://tequila.epfl.ch/download/2.0/docs/writing-clients.odt
 *
 * [mod_tequila-config] Apache Module - Tequila Identity Management,
 * https://tequila.epfl.ch/download/2.0/docs/writing-clients.odt
 */

var https = require('https'),
    os = require("os"),
    debug = require("debug")("passport-tequila:protocol");

var defaults = {};

defaults.myhostname = os.hostname();
defaults.tequila_host = (function () {
    var hostname_bits = defaults.myhostname.split(".");
    hostname_bits[0] = "tequila";
    return hostname_bits.join(".");
})();

/**
 * Obtain an initial authentication ticket from the Tequila server.
 *
 * This is step 1 of § 2, "Local authentication" in [Lecommandeur-eunis-2005].
 *
 * @param req The request object
 * @param res The response object
 * @param done Called as done(e) upon error, done(null, tok) upon success.
 * @property tequila_server The host name of the Tequila server
 * @property tequila_port The port number of the Tequila server (HTTP/S is mandatory)
 * @property service The app-provided service name (like TequilaService in [mod_tequila-config])
 * @property require A filter expression (e.g. "username=~.") (like TequilaAllowIf in [mod_tequila-config])
 * @property request A list of fields to retrieve out of the user's identity, e.g. ['name', 'firstname']
 *         (like TequilaRequest in [mod_tequila-config])
 */
var Protocol = module.exports = function () {
    this.service = defaults.service;
    this.client = "node-passport-tequila";
    this.request = "username=~.";
    this.tequila_host = defaults.tequila_host;
    this.tequila_port = 443;
    this.tequila_createrequest_path = "/cgi-bin/tequila/createrequest";
    // Not /requestauth, as erroneously stated in [Lecommandeur-WritingClients]:
    this.tequila_requestauth_path = "/cgi-bin/tequila/auth";
    this.tequila_fetchattributes_path = "/cgi-bin/tequila/fetchattributes";
};

Protocol.prototype.createrequest = function(req, res, done) {
    debug("createrequest: called for request to " + req.url);

    var url = fullUrl(req);
    var teq_options = {
        client: "node-passport-tequila",
        urlaccess: url,
        service: this.service || ("Document " + url),
        request: this.request || "username=~."
    };
    if (this.require) {
        teq_options.require = this.require.join(",");
    }

    this._teqRequest(this.tequila_createrequest_path, teq_options, done);
};

Protocol.prototype.requestauth = function(res, tequila_answers) {
    res.redirect("https://" + this.tequila_host +
        this.tequila_requestauth_path + "?" +
        "requestkey=" + tequila_answers["key"]);
};

Protocol.prototype.fetchattributes = function (key, done) {
    this._teqRequest(this.tequila_fetchattributes_path,  {key: key}, done);
};

Protocol.prototype._teqRequest = function(path, teq_options, done) {
    var teq_post_payload = dict2txt(teq_options);
    debug("_teqRequest to " + path +"\n" + teq_post_payload);
    var https_options = {
        hostname: this.tequila_host,
        port: this.tequila_port,
        path: path,
        method: 'POST',
        headers: {
            'Content-Length': teq_post_payload.length
        }
    };
    var teq_req = https.request(https_options, function (res) {
        if (res.statusCode != 200) {
            new TequilaServerError(https_options.path).collect(res, done);
            return;
        }
        var buf = '';
        res.on("data", function (txt) {
            buf += txt;
        });
        res.on("end", function () {
            done(null, txt2dict(buf));
        });
    });
    teq_req.on("error", function (e) {
        done(e);
    });
    teq_req.write(teq_post_payload);
    teq_req.end();
};

function fullUrl(req, hostport, protocol) {
    if (! protocol) {
        protocol = req.protocol || "http";
    }
    if (! hostport) hostport = req.headers['host'];
    if (! hostport) {
        var port;
        if (req.app) {  // Express
            port = req.app.settings.port;
        } else {
            port = protocol == "https" ? 443 : 80;
        }
        hostport = defaults.myhostname + ( port == 80 || port == 443 ? '' : ':' + port );
    }
    return protocol + '://' + hostport + req.url;
}

module.exports.defaults = defaults;

function dict2txt(dict, opt_operator) {
    if (! opt_operator) {
        opt_operator = "=";
    }
    return Object.keys(dict).map(function (k) {
        return k + opt_operator + dict[k] + "\r\n";
    }).join("");
}

function txt2dict(txt, opt_operator) {
    if (! opt_operator) {
        opt_operator = "=";
    }
    var dict = {};
    txt.split("\n").forEach(function (line) {
        var sepIndex = line.indexOf(opt_operator);
        var k = line.slice(0, sepIndex);
        var v = line.slice(sepIndex + opt_operator.length);
        dict[k] = v;
    });
    return dict;
}

/**
 * The Tequila server is signaling an error.
 *
 * @constructor
 *
 * @param reason What we were doing when the situation arose, as free-form text.
 */
var TequilaServerError = exports.TequilaServerError = function(reason) {
    this.reason = reason;
};

TequilaServerError.prototype = Object.create(Error.prototype);

/**
 * Collect the information about a failed request to the Tequila server.
 *
 * @param res The response object, as provided to the https callback.
 * @param done The done callback, as provided to createrequest or fetchattributes
 */
TequilaServerError.prototype.collect = function(res, done) {
    var self = this;
    self.code = res.statusCode;
    self.headers = {};
    Object.keys(res.headers).forEach(function (k) {
        self.headers[k] = res.headers[k];
    });
    self.body = '';
    res.on("data", function (txt) {
        self.body += txt;
    });
    res.on("end", function () {
        done(self);
    })
};

TequilaServerError.prototype.toString = function () {
    var self = this;
    var buf = 'TequilaServerError\n\n' + self.reason;
    if (self.code) {
        buf += "\n" + this.code + "\n";
        buf += dict2txt(self.headers, ": ");
        buf += "\n" + this.body;
    }
    return buf;
};