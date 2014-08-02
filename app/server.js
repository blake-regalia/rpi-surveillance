var fs = require('fs');
var os = require('os');
var extend = require('util')._extend;
var child_process = require('child_process');
var exec = child_process.exec;

var request = require('request');
var http = require('http');
var crypto = require('crypto');
var express = require('express');
var dateformat = require('dateformat');
var app = express();
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser')

var T_SECONDS = 1000;
var T_MINUTES = 60*T_SECONDS;

var LOCAL_MOTION_CTRL_PORT = '8080';

var CAPTURE_DIR = '/home/pi/capture';
var MOTION_CONF_PATH = '/etc/motion.conf'
var MOTION_CONF_JSON = __dirname+'/../resource/motion-conf.json';

var S_PORT_MOTION_STREAM = '8081';

var S_RX_TIMESTAMP = '(\\d{4})-(\\d\\d)-(\\d\\d)_(\\d\\d)-(\\d\\d)-(\\d\\d)';
var RX_AVI = new RegExp('^'+'(\\d\\d)_'+S_RX_TIMESTAMP+'\\.avi$');
var RX_JPG = new RegExp('^'+'(\\d\\d)_'+S_RX_TIMESTAMP+'\\.jpg$');

var motion_pid;
var motion_conf;


var H_CONFIG_MODE_STREAM = {
	"width": "1024",
	"height": "576",
	"framerate": "30",
	"quality": "50",
	"ffmpeg_output_movies": "off",
	"extpipe": "off",
};



Object.put = function(object, key) {
	if(typeof object[key] == 'undefined') {
		object[key] = {};
	}
	return object[key];
};

var rx_match = function(regex, string, s_keys) {
	var a_keys = s_keys.split(' ');
	var match = regex.exec(string);
	var info = {' ':[]};
	if(!match) return false;
	info['0'] = match[0];
 	for(var i=1; i<match.length; i++) {
 		var k = a_keys[i-1];
 		if(!k) info[' '].push(match[i]);
 		else info[k] = match[i];
 	}
 	return info;
};


var die = function() {
	console.error.apply(this, arguments);
	process.exit(1);
};


var reload_motion_conf = function(h_conf, f_okay, f_err) {

	f_err = f_err || console.error;

	// construct the motion conf file string
	var s_conf = '';
	for(var e in h_conf) s_conf += e+' '+h_conf[e]+'\n';

	// overwite existing config file
	fs.writeFile(MOTION_CONF_PATH, s_conf, function(err) {
		if(err) return f_err({error: err});

		// force the daemon to reload the config file
		exec('sudo kill -s SIGHUP '+motion_pid, function(err, stdout, stderr) {
			if(err) return f_err({error: 'failed to send message to motion process'});
			if(stderr.length) return f_err({error: 'process message failed: "'+stderr+'"'});
			console.log('reloaded motion conf (f_okay: '+(typeof f_okay)+')');
			f_okay && f_okay({okay:1});
		});
	});
};


// startup
(function() {

	// get the pid of the motion process
	exec('ps xao pid,comm | grep motion', function(err, stdout, stderr) {
		if(!err && (m=/^\s*(\d+)\s+motion/.exec(stdout)) != null) {
			motion_pid = m[1];
		}
		else {
			die('motion daemon process not found');
		}
	});

	// read the conf json file
	fs.readFile(MOTION_CONF_JSON, 'utf8', function(err, data) {
		if(!err) {
			try {
				// parse the json in the conf file
				motion_conf = JSON.parse(data);
			} catch(e) {
				die('trouble parsing the JSON in the motion conf file: ',data);
			}

			// overwrite the existing configuration file and reload the daemon
			reload_motion_conf(motion_conf);
		}
		else {
			die('motion conf file not found in: "'+MOTION_CONF_JSON+'"');
		}
	});

})();


// set views dir and view engine
app.set('views', __dirname+'/views')
app.engine('.html', require('jade').__express);
app.set('view engine', 'jade');


// setup static file accessor for web api
app.use('/file', express.static(CAPTURE_DIR));

// serves any static resource files
app.get(/^\/([\w\-\.]+)\.(js|css|html)$/, function(req, res) {
	var s_ext = req.params[1];
	res.sendfile(req.params[0].toLowerCase()+'.'+s_ext, {root: './'+s_ext});
});

// serves extraneous static fonts
app.get(/^\/(fonts)\/(.*)$/, function(req, res) {
	var s_dir = req.params[0];
	res.sendfile(req.params[1].toLowerCase(), {root: './'+s_dir});
});

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// to support JSON-encoded bodies
app.use(bodyParser.json());

// establish default response type is json
app.use(function(req, res, next) {
	res.type('json');
	console.log(req.method+' '+req.url);
	next();
});


// streaming
(function() {

	// timeout values
	var T_STREAM_HB = 45 * T_SECONDS;
	var T_STREAM_SERVER_STARTUP = 5.5 * T_SECONDS;

	// streaming status
	var b_streaming = 0;
	var b_stream_http = 0;

	// timeout pointer
	var k_streaming = 0;

	// hash of clients
	var h_stream_clients = {};



	app.get('/debug', function(req, res, next) {

		console.log({
			b_streaming: b_streaming,
			b_stream_http: b_stream_http,
			k_streaming: k_streaming,
			h_stream_clients: h_stream_clients,
		});

		res.send('');
	});

	// changes the recording state
	var switch_recording = function(b_status, f_okay) {

		// prepare the conf json object
		var conf = extend({}, motion_conf);

		// recording switched off
		if(!b_status) {

			// apply stream mode config
			for(var e_key in H_CONFIG_MODE_STREAM) {
				conf[e_key] = H_CONFIG_MODE_STREAM[e_key];
			}
		}

		// set streaming status
		b_streaming = b_status? 0: 1;

		// reload the config
		reload_motion_conf(conf, function() {

			// switched recording off successfully
			if(b_streaming) b_streaming = 2;

			// forward callback
			f_okay && f_okay.apply(this, arguments);
		});
	};


	// recording timeout
	var reset_recording_timeout = function() {

		// cancel existing timeout
		if(k_streaming) {
			clearTimeout(k_streaming);
			k_streaming = 0;
		}

		// assure the stream is alive first
		if(b_streaming) {

			// set a timeout to disable the stream server
			k_streaming = setTimeout(disable_stream, T_STREAM_HB);
		}
	};


	// switch recording back on and don't let anything interupt
	var disable_stream = function() {

		console.warn('** DISABLING STREAM **');

		// remove all clients
		for(var ei_client in h_stream_clients) delete h_stream_clients[ei_client];

		// make sure there is a need for this
		if(b_streaming || b_stream_http) {

			// reset streaming flags
			b_streaming = 0; b_stream_http = 0;

			// switch recording back on
			switch_recording(1);
		}
	};


	// enables stream!
	var enable_stream = function() {

		console.log('stream is enabling...');

		// as soon as the stream server is ready
		check_stream_server(function() {

			console.log('stream server ready!');

			// flag stream server ready
			b_stream_http = 1;

			// notify all subscribers
			for(var ei_client in h_stream_clients) {

				// reference this client
				var h_client = h_stream_clients[ei_client];

				// subscriber present
				if(h_client.subscriber) {

					// notify client
					h_client.subscriber();

					// remove subscription
					delete h_client.subscriber;
				}
			}
		});
	};


	// frequently checks the stream server until it is available
	var check_stream_server = function(f_okay) {

		// make an http get request to the stream server
		http.get('http://127.0.0.1:'+LOCAL_MOTION_CTRL_PORT+'/', function(res) {

			console.log('made it!');

			// it's ready!
			f_okay();
		})
			// connetion refused
			.on('error', function() {

				console.log(' - trying again');
				
				// try again (4 times a second)
				setTimeout(function() {
					check_stream_server(f_okay);
				}, 250);
			})
			// timeout error, we're getting close!
			.setTimeout(500, function() {

				console.log(' - getting close!');

				// try again very soon
				setTimeout(function() {
					check_stream_server(f_okay);
				}, 100);
			});
	};


	// subscribes to be notified when stream server is ready
	var subscribe_stream_notify = function(i_client, f_okay, f_error) {

		// the stream server is ready
		if(b_stream_http) {
			f_okay();
		}
		// wait for stream to be ready
		else {

			// entry found for this client
			if(h_stream_clients[i_client]) {
				h_stream_clients[i_client].subscriber = f_okay;
			}
			// no entry found!
			else {
				f_error({
					error: 'No entry found for client id',
					reload: true,
				});
			}
		}
	};


	// sends the stream app to the client
	var send_stream = function(res) {

		// this is gonna be html
		res.type('html');

		// serve the html file (streaming app)
		res.render('stream', {
			host: {
				name: 'Test Camera',
				addr: os.hostname(),
			},
			stream: {
				port: '8081',
			},
		});
	};


	// generate a unique id for this client
	var gen_client_id = function(req, res) {

		// get the cookie hash
		var s_cui = req.cookies.user_id;

		// it exists, return this id
		if(s_cui) return s_cui;

		// encourage to create one
		if(res) {

			// create the unique string
			var s_user = req.ip+':'+Date.now();

			// create the hash
			s_cui = crypto.createHash('md5').update(s_user).digest('hex');

			// set the cookie
			res.cookie('user_id', s_cui);

			// return this id
			return s_cui;
		}

		// not trying to create new cookie
		return false;
	};


	// use cookie parser
	app.use(cookieParser());


	// stream video live
	app.get('/stream', function(req, res, next) {

		// add this client to the stream dict
		var i_client = gen_client_id(req, res);
		h_stream_clients[i_client] = {
			alive: true,
		};

		// streaming is alive or in process of starting up
		if(b_streaming) {

			// send the stream
			send_stream(res);
		}

		// stream needs to be opened
		else {

			// send stream
			send_stream(res);

			// switch off recording so we can start the stream
			switch_recording(0, function() {

				console.log('attempting to do rest of duty');

				// enable ability to subscribe to stream
				enable_stream();

				// revert to recording mode if we don't hear from the client for a while
				reset_recording_timeout();
			});
		}
	});


	// client is requesting the stream when it becomes active
	app.get('/stream-src', function(req, res, next) {

		// get client id
		var i_client = gen_client_id(req, res);

		// when the stream becomes available
		subscribe_stream_notify(i_client, function() {

			// return src info
			res.send({
				src: 'http://192.168.1.124:8081/'
			});
		}, function(err) {

			// return error
			res.send(err);
		});
	});


	// lets the server know the client is still listening to the stream
	app.get('/stream-hb', function(req, res, next) {

		// get client id
		var i_client = gen_client_id(req);

		// stream is not online or client is not authorized
		if(!b_streaming || !i_client || !h_stream_clients[i_client]) {

			// force close their app
			res.send({
				forceClose: 1,
			});
		}
		// normal
		else {

			// reset recording timeout
			reset_recording_timeout();

			// ack
			res.send({okay:1});
		}
	});


	// request to explicity close the stream
	app.get('/stream-close', function(req, res, next) {

		// find this client
		var i_client = gen_client_id(req);
		if(i_client && h_stream_clients[i_client]) {

			// remove client from hash
			delete h_stream_clients[i_client];

			// there are no other clients listening
			var n_stream_clients = Object.keys(h_stream_clients).length;
			if(!n_stream_clients) {

				// shutdown the stream
				disable_stream();
			}
			// there are other clients listening
			else {
				res.send({
					okay: 1,
					otherStreams: n_stream_clients,
				});
				return;
			}
		}

		// respond no matter what
		res.send({okay:1});
	});


	// request all streams be closed
	app.get('/stream-force-close-all-streams', function(req, res, next) {

		// remove all clients
		h_stream_clients = {};

		// void the stream check and force disable stream
		disable_stream();

		// ack
		res.send({
			okay: 1,
		});
	});

})();


// GET /snapshot
app.get('/snapshot', function(req, res, next) {

	//
	console.log('saving snapshot...');

	// make request to local motion server
	request({
		url: 'http://localhost:'+LOCAL_MOTION_CTRL_PORT+'/0/action/snapshot',
		timeout: 1500,
	}, function(err, ires, body) {

		// handle errors
		if(err) {

			// connection refused
			if(err.code == 'ECONNREFUSED') {

				// server is not ready
				res.send({
					error: 'The server is still initializing',
					type: 'booting',
				});
			}
			// not sure what is going on
			else {

				// 
				res.send({
					error: 'Motion failed to acquire snapshot. Unkown error',
				});
			}
		}

		// handle response error
		else if(ires.statusCode != 200) {

			// not sure
			res.send({
				error: 'Motion HTTP server did not like request for snapshot',
			});
		}

		// make a request to capture a snapshot from motion
		else {

			// prepare reference to the snapshot path
			var lastsnap = CAPTURE_DIR+'/lastsnap.jpg';

			// cancel the following while loop after 10 seconds on the event loop
			var waitingTimedOut = false;
			setTimeout(function() {
				waitingTimedOut = true;
			}, 10*T_SECONDS);

			// check for the snapshot file to exists
			var checkSnap = function() {

				// file exists now
				if(fs.existsSync(lastsnap)) {
					clearInterval(checkInterval);
					sendSnapshot();
				}
				// waiting timed out
				else if(waitingTimedOut) {
					clearInterval(checkInterval);
					res.send({
						error: 'Waiting for snapshot file to exist timed out',
						type: 'timeout',
					});
				}
			};

			// interval to check for image (about 10x per second)
			var checkInterval = setInterval(checkSnap, 100);

			// send the snapshot file
			var sendSnapshot = function() {

				// send the snapshot image to the client
				res.type('image/jpeg');
				res.sendfile(CAPTURE_DIR+'/lastsnap.jpg', function(err) {

					// there was an error streaming the snapshot file to client
					if(err) {
						res.send({
							error: 'Failed to stream snapshot file to client via HTTP',
							info: JSON.parse(JSON.stringify(err)),
						});
					}

					// delete all snapshot jpeg files from the capture directory
					exec('rm *snap.jpg', {
						cwd: CAPTURE_DIR,
					});
				});
			};
		}
	});
});


// request for the files in the capture directory as json
app.get('/captured', function(req, res, next) {

	// open the directory for reading
	fs.readdir(CAPTURE_DIR, function(err, files) {

		// could not read from directory
		if(err) return res.send({
			error: 'cannot read dir: '+err
		});

		// send the files array
		res.send({files: files});
	});
});


// 
(function() {

	// request to watch a video
	app.get('/video-play', function(req, res, next) {

		// 
		res.type('video/mp4');
		res.sendfile(CAPTURE_DIR+'/last_vid.mp4', function(err) {

			if(err) {
				res.send({
					error: 'Failed to send video file to client via HTTP',
					info: JSON.parse(JSON.stringify(err)),
				});
			}
		});

	});

	app.get(/\/preview\/([\d\-_\.]+)\.(jpg|png)$/, function(req, res, next) {
		var s_file = req.params[0];
		var s_ext = req.params[1];
		if(s_ext == 'jpg') {
			res.type('image/jpeg');
			res.sendfile(CAPTURE_DIR+'/'+s_file+'.'+s_ext, function(err) {
				if(err) {
					res.send({
						error: 'Failed to send thumbnail file to client via HTTP',
						info: JSON.parse(JSON.stringify(err)),
					});
				}
			});
		}
		else if(s_ext == 'png') {
			res.type('image/png');
			res.sendfile('../resource/'+s_file+'.'+s_ext, function(err) {
				if(err) {
					res.send({
						error: 'Failed to send thumbnail file to client via HTTP',
						info: JSON.parse(JSON.stringify(err)),
					});
				}
			});
		}
		else {
			res.send('wtf?');
		}
	});

	// request to watch videos
	app.get('/watch', function(req, res, next) {

		// this is gonna be html
		res.type('html');

		// serve the html file (watching app)
		res.render('watch', {
		});
	});

	app.get(/^\/watch\/([^\/]+)$/, function(req, res, next) {

		// 
		var s_type = /(\.\w+)$/.exec(req.params[0])[1];
		res.type('video/'+s_type);
		res.sendfile(CAPTURE_DIR+'/'+req.params[0], function(err) {

			if(err) {
				res.send({
					error: 'Failed to send video file to client via HTTP',
					info: JSON.parse(JSON.stringify(err)),
				});
			}
		});
	});

	app.post('/durations', function(req, res, next) {
		var a_movies = req.body['movies[]'];
		var h_durations = {};
		for(var i=0; i<a_movies.length; i++) {
			var s_movie = a_movies[i];
			console.log(s_movie.substr(0, s_movie.length-4));
			h_durations[s_movie] = fs.readFileSync(CAPTURE_DIR+'/'+s_movie.substr(0, s_movie.length-4)+'.duration', {encoding:'utf8'});
		}
		console.log(h_durations);
		res.send(h_durations);
	});

})();


// movies
(function() {

	// media file filter
	var X_FILE_MEDIA = /^(.+)\.(\w+)$/;
	var X_DURATION = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+),/;

	var T_CONVERT_VACANCY = 12*T_MINUTES;
	var T_CONVERT_BUSY = 30*T_SECONDS;

	// convert the next video to appropriate stream
	var convert_next = function(){

		// start with all files
		fs.readdir(CAPTURE_DIR, function(err, files) {

			// wtf?
			if(err) {
				console.error('Failed to read capture directory: ',err);
				return setTimeout(convert_next, T_CONVERT_BUSY);
			}

			// sort the directory (ascending chronological order)
			files.sort();

			// prepare to find the earliest video
			var s_earliest_avi = false;

			// iterate through all files
			for(var i=0; i<files.length; i++) {

				// reference filename
				var s_file = files[i];

				// do a match on filename
				if(m_file=X_FILE_MEDIA.exec(s_file)) {

					var s_basename = m_file[1];
					var s_ext = m_file[2];

					// this is an unconverted video
					if(s_ext == 'avi') {

						// there is already a previous avi
						if(s_earliest_avi) break;

						// assume it is the earliest one
						s_earliest_avi = s_basename;
					}
					else if(s_ext == 'busy' && s_earliest_avi){
						
					}
					// encountered a movie
					else if(s_ext == 'mp4' && s_earliest_avi) {

						// it matches the "earliest" movie
						if(s_basename == s_earliest_avi) {

							// (attempt to) delete the spare avi file
							fs.unlink(CAPTURE_DIR+'/'+s_earliest_avi+'.avi', function(){});

							// continue
							s_earliest_avi = false;
						}
						// some other movie, we found the first avi
						else {
							break;
						}
					}
				}
			}

			// convert the video
			if(s_earliest_avi) {

				// create a file that tells this is converting
				fs.open(CAPTURE_DIR+'/'+s_earliest_avi+'.busy', 'w', function(){});

				console.log('converting "'+s_earliest_avi+'"...');
				exec('avconv -i '+CAPTURE_DIR+'/'+s_earliest_avi+'.avi -c:v libx264 -preset veryfast -crf 28 -an -y '+CAPTURE_DIR+'/'+s_earliest_avi+'.mp4', function(err, stdout, stderr) {
					if(err) console.error('Failed to convert video: ',err);

					// success!
					else {

						// get duration from stderr
						var m_duration = X_DURATION.exec(stderr);
						var s_hours = m_duration[1];
						var s_minutes = m_duration[2];
						var s_seconds = m_duration[3];
						var s_centiseconds = m_duration[4];

						var n_milliseconds = parseInt(s_centiseconds)*100
							+parseInt(s_seconds)*T_SECONDS
							+parseInt(s_minutes)*T_MINUTES
							+parseInt(s_hours)*60*T_MINUTES;

						// create a file that describes the duration
						fs.writeFile(CAPTURE_DIR+'/'+s_earliest_avi+'.duration', n_milliseconds+'', function(err) {
							if(err) console.error('failed to save duration ['+n_milliseconds+'] to file: "'+s_earliest_avi+'"', err);
						});

						// attempt to delete the original avi file and busy file
						fs.unlink(CAPTURE_DIR+'/'+s_earliest_avi+'.avi', function(){});
						fs.unlink(CAPTURE_DIR+'/'+s_earliest_avi+'.busy', function(){});

						// immediately attempt processing the next video
						return setTimeout(convert_next, 0);
					}

					// no matter what
					fs.unlink(CAPTURE_DIR+'/'+s_earliest_avi+'.busy');
					setTimeout(convert_next, T_CONVERT_BUSY);
				});
			}

			// try again later
			else {
				setTimeout(convert_next, T_CONVERT_VACANCY);
			}
		});
	};

	// start the process
	convert_next();

})();



// 
app.get('/qkjns', function(req, res, next) {

	// max_movie_time
	// quality
	// stream_quality
	// ffmpeg_variable_bitrate
});

// conversion
// avconv -i %input.avi -c:v libx264 -preset veryfast -crf 28 -an -y %output.mp4


// start the host server for handling requests
app.listen(3005, function() {
	console.log('ready');
});