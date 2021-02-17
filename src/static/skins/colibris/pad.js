'use strict';

const customStart = () => { /* eslint-disable-line no-unused-vars */
  $('#pad_title').show();
  $('.buttonicon').mousedown(function () { $(this).parent().addClass('pressed'); });
  $('.buttonicon').mouseup(function () { $(this).parent().removeClass('pressed'); });
};
