
var S_OPTION_REMOTE = 'http://rpi-deck:3005';

var T_SECONDS = 1000;
var T_MAX_LOAD = 15*T_SECONDS;
var T_HEART_BEAT = 5*T_SECONDS;

// initialize
$(document).ready(function() {

	// // clear the user id cookie
	// document.cookie = 'user_id=;expires=Thu, 01 Jan 1970 00:00:00 GMT';

	// the heartbeat timer
	var k_heart_beat;
	var q_stream = $('#stream');

	// prepare a timeout, 

	// request the source of the stream
	$.ajax({
		url: '/stream-src',
		type: 'GET',
		dataType: 'json',
		timeout: T_MAX_LOAD,
		error: function(d_xhr, s_reason) {
			if(s_reason == 'timeout') {
				close_app('Connection was interrupted. Try starting a new stream');
			}
		},
		success: function(json) {

			// error from server
			if(json.error) {

				// direction to reload
				if(json.reload) window.location.reload();

				// either way, don't continue
				return console.error(json.error);
			}

			// assign the proper image source
			q_stream.attr('src', json.src)

				// image failed to load
				.error(function() {

					// please be patient
					$('#patience').show();

					// force the image to reload in a bit
					setTimeout(function() {
						q_stream.attr('src', json.src);
					}, 500);
				})

				// image loaded
				.load(function() {

					// did it really load?
					setTimeout(function() {

						// did not really load!
						if(!q_stream.get(0).naturalWidth) return q_stream.attr('src', json.src);

						// remove patience label
						$('#patience').remove();

						// show controls
						$('#controls').show();

					}, 25);
				});

			// show the stage
			$('#stage').show();

			// remove the loading overlay
			$('#loading').remove();

			// start the heart-beat
			k_heart_beat = setInterval(function() {

				// heart-beat request, let the server know we're still listening
				$.ajax({
					url: '/stream-hb',
					type: 'GET',
					dataType: 'json',
					timeout: T_HEART_BEAT*.85,

					// did not hear back from server or server threw error
					error: function(d_xhr, s_reason) {

						// cancel heartbeat
						clearInterval(k_heart_beat);

						// close the page
						close_app({
							error: 'You lost connection to the server',
						});
					},

					// server responded!
					success: function(json) {

						// look out for force-closures
						if(json.forceClose) {

							// cancel the heart-beat
							clearInterval(k_heart_beat);

							// close the page
							close_app(json);
						}
					},
				});

			}, T_HEART_BEAT);
		},
	});

	// warning pre/post html
	var S_WARNING_PRE = '<div class="warning"><i class="fa fa-warning"></i> <span>';
	var S_WARNING_POS = '</span></div>';

	// close the app and display information
	var close_app = function(json) {

		// for the mid-part of the message
		var s_middle = '';

		// there is an object to read
		if(json) {

			// there are other streams open
			if(json.otherStreams) {

				// streams info
				var s_streams_info = 'is 1 other stream';
				if(json.otherStreams && json.otherStreams > 1) {
					s_streams_info = 'are '+json.otherStreams+' other streams';
				}

				// construct middle
				s_middle = ''
					+S_WARNING_PRE+'There '+s_streams_info+' still open. Recording will not resume until all streams have been closed'+S_WARNING_POS
					+'<button class="force-close"><i class="fa fa-power-off"></i> <span>Close other streams</span></button>';
			}
			// stream was force closed
			else if(json.forceClose) {

				// construct middle
				s_middle = ''
					+S_WARNING_PRE+'Sorry, your stream was force closed by another user'+S_WARNING_POS;
			}
			// catch-all error
			else if(json.error) {

				// construct middle
				s_middle = ''
					+S_WARNING_PRE+json.error+S_WARNING_POS;
			}
		}

		// remove everything
		$(document.body).empty()
			.append(''
				+'<div class="main message">'
					+'<div>Stream has been closed</div>'
					+s_middle
					+'<button class="reload"><i class="fa fa-play"></i> <span>Open new stream</span></buton>'
				+'</div>');
	};

	// all button clicks
	$(document).on('click', 'button', function() {

		// disable this button
		$(this).prop('disabled', true);
	})


	// button click: snapshot
	$(document).on('click', 'button.snapshot', function() {

		// open a new window with the snapshot
		window.open('/snapshot', '_blank');

		// enable this button again
		$(this).prop('enable');
	});


	// button click: close
	$(document).on('click', 'button.close', function() {

		// cancel the heart-beat
		clearInterval(k_heart_beat);

		// first make the ajax request to let the server know we are closing the page
		$.getJSON('/stream-close', close_app);
	});


	// button click: reload
	$(document).on('click', 'button.reload', function() {

		// reload this page!
		window.location.reload();
	});


	// button click: force-close
	$(document).on('click', 'button.force-close', function() {

		// request all other streams be closed
		$.getJSON('/stream-force-close-all-streams', function() {

			// remove this extra output
			close_app();
		});
	});

});

