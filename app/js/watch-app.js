

// once the document has loaded
$(document).ready(function() {

	//
	var S_SRC_THUMB_NOT_FOUND = '_';

	// file filters
	var X_FILE_JPEG = /\.jpe?g$/;
	var X_FILE_MP4 = /\.mp4$/;
	var X_FILE_AVI = /\.avi$/;

	// file containers
	var a_file_images = [];
	var a_file_movies = [];
	var a_file_videos = [];

	// all the files
	var a_files = [];

	// get all converted movie files
	$.ajax({
		url: '/captured-videos',
		type: 'GET',
		dataType: 'json',
		success: function(json) {

			// update local copy of files
			a_files = json.files;

			// filter the files into arrays by media type
			for(var i=0; i<a_files; i++) {

				// reference each filename
				var s_file = a_files[i];

				// image (thumbnail or snapshot)
				if(X_FILE_JPEG.test(s_file)) {
					a_file_images.push(s_file);
				}
				// polished movie
				else if(X_FILE_MP4.test(s_file)) {
					a_file_movies.push(s_file);
				}
				// unconverted video
				else if(X_FILE_AVI.test(s_file)) {
					a_file_videos.push(s_file);
				}
			}

			// prepare an html for the whole page
			var r_page = ''

			// iterate over all movies
			for(var i=0; i<a_file_movies.length; i++) {

				// reference each movie filename
				var s_movie = a_file_movies[i];

				// matching prefix `2014-07-28_21-19-07_03` 10 matches same day
				var s_match_prefix = s_movie.substr(0, 10);
				var s_match_suffix = s_move.substr(20, 2);

				// keep best / better matches
				var s_best_match, a_good_match = [];

				// match the movie to a thumbnail by event criteria
				for(var i_image=0; i_image<a_file_images.length; i++) {

					// get the image filename for testing
					var s_image = a_file_images[i_image];

					// attempt to match suffix (event #)
					if(s_image.substr(20, 2) == s_match_suffix) {

						// good match at least
						a_good_match.push(s_image);

						// best match?
						if(s_image.substr(0, 10) == s_match_prefix) {
							s_best_match = s_image;
							break;
						}
					}
				}

				// best match was not found
				if(!s_best_match) {

					// there was only one good match!
					if(a_good_match.length == 1) s_best_match = a_good_match[0];

					// multiple matches or none at all
				}

				// remove best match from image array
				if(s_best_match) {
					var i_best_match = a_file_images.indexOf(s_best_match);
					a_file_images.splice(i_best_match, 1);
				}
				// otherwise, set it to the default 'dunno' thumbnail
				else {
					s_best_match = S_SRC_THUMB_NOT_FOUND;
				}

				// finally, create a playable thumbnail
				var r_event = ''
					+'<div class="play" data-src="'+btoa(s_file)+'">'
						+'<span>'+s_file+'</span>'
						+'<img src="/preview/'+s_best_match+'">'
					+'</div>';

				// append this html to the construct
				r_page += r_event;
			}

			// build the page all at once
			$(r_page).appendTo(document.body);

			// bind event listeners
			$(document).on('click', '.play', function() {
				var q_this = $(this);
				var z_image = q_this.attr('data-src');
				var s_image;
				try {
					s_image = atob(z_image);
				} catch(e) {}
				console.log(s_image);
			});
		},
	});

});