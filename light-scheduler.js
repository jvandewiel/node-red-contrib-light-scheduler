module.exports = function(RED) {
  "use strict";
  var path = require('path');
  var req = require('request');
  var util = require('util');
  var scheduler = require('./lib/scheduler.js');
  var isItDark = require('./lib/isitdark.js');
  var moment = require('./static/moment.min.js');

  var LightScheduler = function(n) {

    RED.nodes.createNode(this, n);
    this.settings = RED.nodes.getNode(n.settings); // Get global settings
    this.events = JSON.parse(n.events);
    this.topic = n.topic;
    this.onPayload = n.onPayload;
    this.onPayloadType = n.onPayloadType;
    this.offPayload = n.offPayload;
    this.offPayloadType = n.offPayloadType;
    this.onlyWhenDark = n.onlyWhenDark;
    this.sunElevationThreshold = n.sunElevationThreshold ? n.sunElevationThreshold : 6;
    this.sunShowElevationInStatus = n.sunShowElevationInStatus | false;
    this.outputfreq = n.outputfreq ? n.outputfreq : 'output.statechange.startup';
    this.override = 'auto';
    this.prevPayload = null;
    // added
    this.eventInfoFormat = n.eventInfoFormat ? n.eventInfoFormat : 'yy-mm-ddThh-mm-ss';
    this.nextEvent = '';
    var node = this;

    function setState(out) {
      var msg = {
        topic: node.topic,
      };
      if (out)
        msg.payload = RED.util.evaluateNodeProperty(node.onPayload, node.onPayloadType, node, msg);
      else
        msg.payload = RED.util.evaluateNodeProperty(node.offPayload, node.offPayloadType, node, msg);

      var sunElevation = '';
      if (node.sunShowElevationInStatus) {
        sunElevation = '  Sun: ' + isItDark.getElevation(node).toFixed(1) + '°';
      }

      var overrideTxt = node.override == 'auto' ? '' : '  Override: ' + node.override;
      // when next event occurs
      var nextEvtTxt = node.override == 'auto' ? node.nextEvent : '';

      node.status({
        fill: out ? "green" : "red",
        shape: "dot",
        text: (out ? 'ON' : 'OFF') + sunElevation + overrideTxt + nextEvtTxt
      });

      // Only send anything if the state have changed.
      if (node.outputfreq == 'output.minutely' || msg.payload !== node.prevPayload) {
        node.prevPayload = msg.payload;
        node.send(msg);
      }
    }


    function evaluate() {
      // Handle override state, if any.
      if (node.override == 'stop') {
        node.status({
          fill: "gray",
          shape: "dot",
          text: 'Override: Stopped!'
        });
        return;
      }

      if (node.override == 'on')
        return setState(true);

      if (node.override == 'off')
        return setState(false);

      var matchEvent = scheduler.matchSchedule(node);

      if (node.override == 'schedule-only')
        return setState(matchEvent);

      if (node.override == 'light-only')
        return setState(isItDark.isItDark(node));

      // node.override == auto
      if (!matchEvent)
        return setState(false);

      if (node.onlyWhenDark)
        return setState(isItDark.isItDark(node));

      return setState(true);
    };

    // return events list sorted by actual date
    function orderByDate(arr, dateProp) {
      return arr.slice().sort(function(a, b) {
        return a[dateProp] < b[dateProp] ? -1 : 1;
      });
    };

    // get real dates and sort by start, if evt time is AFTER
    // now on today, then move it to next week
    function getEventDates() {
      var evts = [];
      var now = moment();
      for (var i in node.events) {
        var e = node.events[i];
        // subtract 1 to correct for start on Monday instead of Sunday
        var start = moment().day(e.start.dow).hours(Math.floor(e.start.mod / 60)).minutes(e.start.mod % 60).seconds(0).millisecond(0);
        var end = moment().day(e.end.dow).hours(Math.floor(e.end.mod / 60)).minutes(e.end.mod % 60).seconds(0).millisecond(0);
        // if now is after end, then .add(7, 'days')
        if (now.isAfter(end)) {
          start.add(7, 'days');
          end.add(7, 'days');
        };
        var e = {
          start: start.local().format("YYYY-MM-DDTHH:mm:ss"),
          end: end.local().format("YYYY-MM-DDTHH:mm:ss")
        };
        evts.push(e)
      }
      var evts = orderByDate(evts, 'start');
      return evts;
    };

    node.on('input', function(msg) {
      msg.payload = msg.payload.toString(); // Make sure we have a string.
      if (msg.payload.match(/^(1|on|0|off|auto|stop|schedule-only|light-only)$/i)) {
        if (msg.payload == '0') msg.payload = 'off';
        if (msg.payload == '1') msg.payload = 'on';
        node.override = msg.payload.toLowerCase();
        //console.log("Override: " + node.override);
      } else if (msg.payload.match(/^(info|next)$/i)) {

        // info:all, info:next, reflect next evt time in status
        // if linked to dark, include this e.g. if time is set to 16:00
        // but it is first dark @16:20, show/set that
        // as <status ON|OFF> ON @<next start> | OFF @<next end>, update when
        // occurs, include today | tomorrow | date of next evt
        // use formatted datetime (string def in html)
        // add type to event in schedule (topic)
        var evts = getEventDates(); // store in var and update after change

        switch (msg.payload) {
          case 'info':
            // return all events, sorted and formatted
            var msg = {
              topic: node.topic,
              payload: evts
            };
            break;
          case 'next':
            // return first next event, loop to find correct start/end
            var e = {};
            if (evts.length > 0) {
               e = evts[0];
            } else {
              e = 'no event';
            };

            var now = moment();
            var p = {};
            // check for start or stop
            if (now.isAfter(e.start)) {
              p.event = 'OFF';
              p.time = moment(e.end).format("YYYY-MM-DDTHH:mm:ss");
              node.nextEvent = ' OFF @' + moment(e.end).format("HH:mm");
            } else {
              p.event = 'ON';
              p.time = moment(e.start).format("YYYY-MM-DDTHH:mm:ss");
              node.nextEvent = ' ON @' + moment(e.start).format("HH:mm");
            }
            console.log(node);
            // send next event
            var msg = {
              topic: node.topic,
              payload: p
            };
            break;
        }
        // send and out of here
        node.send([null, msg]);
        // need to update status
        return;
      } else if (msg.payload.match(/^(lux)$/i)) {
        console.log('lux override')
      } else {
        node.warn('Failed to interpret incomming msg.payload. Ignoring it!');
        evaluate();
      }
    });

    // re-evaluate every minute
    node.evalInterval = setInterval(evaluate, 60000);

    // Run initially directly after start / deploy.
    if (node.outputfreq != 'output.statechange')
      setTimeout(evaluate, 1000);

    node.on('close', function() {
      clearInterval(node.evalInterval);
    });
  };


  RED.nodes.registerType("light-scheduler", LightScheduler);

  RED.httpAdmin.get('/light-scheduler/js/*', function(req, res) {
    var options = {
      root: __dirname + '/static/',
      dotfiles: 'deny'
    };
    res.sendFile(req.params[0], options);
  });
};
