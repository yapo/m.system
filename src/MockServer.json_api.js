module.exports = TemplateJSON;

function TemplateJSON(profile) {
	var fs = require("fs");
	var tools = require("./MockServerUtil.js");
	var Hapi = require("hapi");
	var service =  (profile.server.protocol == "https:") ? require("https") : require("http");
	var mock = new Hapi.Server();
	var headersToIgnore = ["date", "host", "content-length"];

	// - - - - - - - - - - - - - - - - - - - - - - -

	var getReplyPathPrefix = function(reply){
		return (profile.workingDir + "/" + profile.name + "/"
				+ profile.mode + "/" + profile.stage + "/" + reply);
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var defaultStaticHandler = function(request, reply){
		tools.Utils.debug(profile, "static handler for",
				request.route.method.toUpperCase(), request.route.path);
		var rule;
		// get the rule from the route
		for (var i = 0, len = profile.rules[profile.stage].static.length; i < len; i++) {
			rule = profile.rules[profile.stage].static[i];
			if (rule.method.toLowerCase() == request.route.method.toLowerCase()
					&& rule.path == request.route.path){
				break;
			 }
		}
		var dumpPath = tools.Utils.getResponseDumpPath(profile, rule);
		tools.Utils.debug(profile, "retrieving file ", dumpPath);
		dump = JSON.parse(fs.readFileSync(dumpPath));
		replyFromDump(profile, reply, dump);
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var requestRecorder = function(request, reply){
		tools.Utils.debug(profile, "recording",
				request.method.toUpperCase(), request.path);
		profile.currentCounter++;
		var dump = {};
		var headers = [];
		for (var key in request.headers){
			if (headersToIgnore.indexOf(key) == -1){
				headers.push({key: key, value: request.headers[key]});
			}
		}
		dump.request = {
			path: request.path,
			method: request.method,
			headers: headers,
			payload: request.payload
		};
		// get response from real server
		var options = {
			host: profile.server.host,
			port: profile.server.port,
			protocol: profile.server.protocol,
			path: request.path,
			method: request.method,
			rejectUnauthorized: false
		};
		var callback = function(response) {
				// save the response's centextual data
				var headers = [];
				for (var key in response.headers){
					if (headersToIgnore.indexOf(key) == -1){
						headers.push({key: key, value: response.headers[key]});
					}
				}
				dump.response = {
					headers: headers,
					statusCode: response.statusCode
				};
				// save the response body
				var body = "";
				response.on("data", function(data){
						body += data.toString();
					});
				response.on("end", function(){
						dump.response.body = JSON.parse(body);
						tools.Utils.dumpJsonResponse(profile, dump);
						replyFromDump(profile, reply, dump);
					});
			};
		// make the fuking request!
		service.request(options, callback)
			.on("error", function(e){
						tools.Utils.error(profile, "Error on request", e);
					})
			.end(JSON.stringify(request.payload));
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var requestPlayer = function(request, reply){
		tools.Utils.debug(profile, "playing", request.method, request.path);

		// prepare the response
		profile.currentCounter++;
		var dumpPath = tools.Utils.getResponseDumpPath(profile);
		tools.Utils.debug(profile, "retrieving file ", dumpPath);
		dump = JSON.parse(fs.readFileSync(dumpPath));
		replyFromDump(profile, reply, dump);
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var replyFromDump = function(profile, reply, dump){
		var replyObj = reply(dump.response.body);
		for (var i = 0, len = dump.response.headers.length - 1; i < len; i++) {
			header = dump.response.headers[i];
			replyObj.header(header.key, header.value);
		}
		applyDynamicRules(profile, dump);
		replyObj.code(dump.response.statusCode);
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var applyDynamicRules = function(profile, dump){
		if (! profile.replacements){
			return false;
		}
		var rule;
		for (var i = 0, len = profile.replacements.length; i < len; i++) {
			rule = profile.replacements[i];
			if (rule.method.toLowerCase() != dump.request.method){
				continue;
			}
			if (rule.path != dump.request.path){
				continue;
			}
			if (! rule.stages){
				continue;
			}
			if (rule.stages.indexOf(profile.stage) == -1){
				continue;
			}
			tools.Utils.debug(profile, "apply replace at stage: " + profile.stage + " route: " + rule.method + " " + rule.path);
			try{
				eval("dump.response.body." + rule.node + " = (function(){" + rule.code + "})()")
			} catch(e){
				tools.Utils.error(profile, "error applying rule:", e);
			}
		}
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var killMock = function(options){
		var restart = (options && options.restart) ? options.restart : false ;
		if (mock) {
			tools.Utils.debug(profile, "stoping ", profile.name, "server");
			mock.stop({timeout: 1000}, (err) => {
				tools.Utils.debug(profile, "server stoped");
				if (restart){
					mock = new Hapi.Server();
					start();
				}
			});
		}
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var startMock = function(){
		// check the tls configutation
		var tls = profile.connection.tls;
		if (tls && !tls.key && tls.keyPath){
			tls.key = fs.readFileSync(tls.keyPath);
		}
		if (tls && !tls.cert && tls.certPath){
			tls.cert = fs.readFileSync(tls.certPath);
		}

		// connect the server
		mock.connection(profile.connection);

		// handle CORS
		mock.ext("onPreResponse", require("hapi-cors-headers"));

		mock.start(function (err){
			if (err) {
				profile.error(err);
				return;
			};
			tools.Utils.debug(profile, "started", profile.type,
				"server, running at", mock.info.uri);
		});
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var loadStaticRules = function(){
		if (profile.rules[profile.stage] == null){
			return;
		}
		var route, rules = profile.rules[profile.stage].static;
		if (!rules) {
			return;
		}
		for (var i = 0, len = rules.length; i < len; i++) {
			tools.Utils.debug(profile, "adding route:",
					rules[i].method.toUpperCase(), rules[i].path);
			mock.route({
				method: rules[i].method,
				path: rules[i].path,
				handler: (rules[i].handler) ? rules[i].handler : defaultStaticHandler
			});
		}
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var setRecordingRule = function(){
		tools.Utils.debug(profile, "setting recording rule");
		mock.route({
			method: "*",
			path: "/{path*}",
			handler: requestRecorder
		});
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var loadPlayerRules = function(){
		// load json from dump file
		if (!profile.rules) {
			profile.rules = {};
		}
		if (mock.connections.length > 0) {
			mock.route({
				method: "*",
				path: "/{path*}",
				handler: requestPlayer
			});
		}
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var start = function(){
		tools.Utils.debug(profile, "creating", profile.type,
				"server, at port", profile.connection.port);
		startMock();
		profile.currentCounter = 0;
		switch(profile.mode){
				case "static":
					loadStaticRules();
					break;
				case "record":
					setRecordingRule();
					break;
				case "play":
					loadPlayerRules();
		}
	};

	// - - - - - - - - - - - - - - - - - - - - - - -

	var stop = function(){
		killMock();
	};

	// - - - - - - - - - - - - - - - - - - - - - - -

	var setMode = function(mode){
		if (!tools.Utils.validateMode(mode)){
			tools.Utils.error(profile, "Mode " + mode + "not valid", "Could not set mode");
			return;
		}
		if (mode === profile.mode){
			tools.Utils.debug(profile, "mode", mode, "already set");

			return false;
		}

		tools.Utils.debug(profile, "setting mode to", mode);
		profile.mode = mode;
		profile.currentCounter = 0;
		tools.Utils.ensurePath(profile);
		killMock({restart: true});
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var setStage = function(stage){
		if (typeof(stage) == "undefined"){
			stage = "default";
		}
		tools.Utils.debug(profile, "setting stage to", stage);
		profile.stage = stage;
		if (profile.mode == "record"){
			tools.Utils.cleanStage(profile);
		}
		tools.Utils.ensurePath(profile);
		profile.currentCounter = 0;
	}

	// - - - - - - - - - - - - - - - - - - - - - - -

	var config = function(setup){
		if (setup){
			if (setup.mode){
				setMode(setup.mode);
			};
			if (setup.stage){
				setStage(setup.stage);
			};
		};
		return this.getConfig();
	};

	// - - - - - - - - - - - - - - - - - - - - - - -

	var getConfig = function(){
		return JSON.parse(JSON.stringify(profile));
	};

	// - - - - - - - - - - - - - - - - - - - - - - -
	// Constructor
	profile.currentCounter = 0;
	setStage(profile.stage);
	if (!tools.Utils.validateMode(profile.mode)){
		profile.mode = "play";
	};
	tools.Utils.ensurePath(profile);

	// - - - - - - - - - - - - - - - - - - - - - - -

	return{
		start: start,
		stop: stop,
		config: config,
		getConfig: getConfig
	};
}
