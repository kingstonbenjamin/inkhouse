// Inkhouse demo backend: replaces XMLHttpRequest with an in-page fake of the proxy API,
// so the real panel page runs on a static host with sample data. Taps change the sample state.
(function () {
  var NOW = new Date().getTime(), H = 3600000;
  function iso(ms) { return new Date(ms).toISOString(); }
  function at(hoursAgo) { return Math.round((NOW - hoursAgo * H) / 1000); }

  var ROOMS = [
    ['living_room', 'Living room', 24.5, 52, 6.2, null, true],
    ['bedroom', 'Bedroom', 25.0, 48, 7.8, 12, true],
    ['kids_room', 'Kids room', 25.5, 50, 0.0, null, false],
    ['office', 'Office', 26.0, null, 1.4, 3, false],
    ['kitchen', 'Kitchen', 26.5, 55, 0.0, null, false],
    ['guest_room', 'Guest room', 27.0, 47, 0.0, 12, false]
  ];

  var ui = {
    personName: 'Alex', person: 'person.alex',
    outside: { temp: 'sensor.outdoor_temperature', humidity: 'sensor.outdoor_humidity' },
    rooms: [], allOff: 'script.ac_all_off',
    energy: { kwh: 'sensor.ac_kwh_today', hours: 'sensor.ac_hours_today', note: 'Demo data. On a real panel this page shows your own sensors.' },
    lock: { entity: 'lock.front_door', battery: 'sensor.front_door_lock_battery' },
    vacuum: {
      entity: 'vacuum.robot', battery: 'sensor.robot_battery', lastClean: 'sensor.robot_last_clean', sensorDirty: 'sensor.robot_sensor_time_left',
      settings: [
        { label: 'Mode', entity: 'select.robot_cleaning_mode', usual: 'mopping_after_sweeping', step: 1 },
        { label: 'Suction', entity: 'select.robot_suction_level', usual: 'standard', step: 2 },
        { label: 'Mop', entity: 'select.robot_mop_humidity', usual: 'moist', step: 2, offFor: ['sweeping'] },
        { label: 'Route', entity: 'select.robot_route', usual: 'standard', step: 3 },
        { label: 'Floor', entity: 'select.robot_map', usual: 'Map 1' }
      ],
      resetSensor: 'button.robot_reset_sensor', shortcut: { name: 'Daily', entity: 'button.robot_shortcut' }
    },
    dishwasher: {
      state: 'sensor.dishwasher_operation_state', door: 'sensor.dishwasher_door', finish: 'sensor.dishwasher_finish_time',
      progress: 'sensor.dishwasher_progress', remoteStart: 'binary_sensor.dishwasher_remote_start',
      selected: 'select.dishwasher_selected_program', active: 'select.dishwasher_active_program',
      delay: 'number.dishwasher_start_in_relative', stop: 'button.dishwasher_stop_program',
      usual: 'dishcare_dishwasher_program_eco_50',
      options: [
        { label: 'Intensive zone', entity: 'switch.dishwasher_intensive_zone' }, { label: 'Speed', entity: 'switch.dishwasher_speed' },
        { label: 'Hygiene', entity: 'switch.dishwasher_hygiene' }, { label: 'Half load', entity: 'switch.dishwasher_half_load' },
        { label: 'Silence', entity: 'switch.dishwasher_silence' }
      ],
      startTimes: [['Now', null], ['10 PM', '22:00'], ['11 PM', '23:00'], ['Midnight', '00:00']]
    },
    routines: [{ label: 'Good night', icon: 'moon', entity: 'script.good_night' }],
    garden: { zones: [{ name: 'Front lawn', entity: 'binary_sensor.front_lawn_watering' }, { name: 'Back lawn', entity: 'binary_sensor.back_lawn_watering' }], next: 'sensor.lawn_next_cycle' },
    wifi: { wan: 'binary_sensor.internet', devices: 'sensor.wifi_devices' },
    nas: { cpu: 'sensor.nas_cpu_temperature', drive: 'sensor.nas_drive_temperature' },
    cameras: [{ name: 'Porch', entity: 'camera.porch' }, { name: 'Garage', entity: 'camera.garage' }, { name: 'Garden', entity: 'camera.garden' }],
    labels: { 'Map 1': 'Downstairs', 'Map 2': 'Upstairs' },
    alerts: { nasCpu: 80, nasDrive: 50, lockBattery: 20, vacuumSensorHours: 5 }
  };

  var E = {};
  function put(id, s, a, hoursAgo) { E[id] = { s: s, a: a || {}, c: at(hoursAgo || 1) }; }
  var FANS = ['low', 'medium', 'high', 'auto'], MODES = ['off', 'cool', 'dry', 'fan_only', 'auto'];
  for (var i = 0; i < ROOMS.length; i++) {
    var r = ROOMS[i], id = r[0];
    ui.rooms.push({ name: r[1], climate: 'climate.' + id, hours: 'sensor.' + id + '_ac_hours', humidity: r[3] === null ? null : 'sensor.' + id + '_humidity', alertHours: r[5] });
    put('climate.' + id, r[6] ? 'cool' : 'off', { temperature: r[6] ? 24 : null, current_temperature: r[2], fan_mode: 'auto', min_temp: 16, max_temp: 30, target_temp_step: 0.5, hvac_modes: MODES, fan_modes: FANS }, r[6] ? 3 : 5);
    put('sensor.' + id + '_ac_hours', String(r[4]));
    if (r[3] !== null) put('sensor.' + id + '_humidity', String(r[3]), { unit_of_measurement: '%' });
  }
  put('person.alex', 'home');
  put('sensor.outdoor_temperature', '29.4'); put('sensor.outdoor_humidity', '58');
  put('sensor.ac_kwh_today', '11.6'); put('sensor.ac_hours_today', '15.4');
  put('lock.front_door', 'locked'); put('sensor.front_door_lock_battery', '81');
  put('vacuum.robot', 'docked', { battery_level: 100 }, 20);
  put('sensor.robot_battery', '100'); put('sensor.robot_last_clean', iso(NOW - 26 * H)); put('sensor.robot_sensor_time_left', '3');
  var OPTS = {
    'select.robot_cleaning_mode': ['sweeping', 'mopping', 'sweeping_and_mopping', 'mopping_after_sweeping'],
    'select.robot_suction_level': ['quiet', 'standard', 'strong', 'turbo'],
    'select.robot_mop_humidity': ['slightly_dry', 'moist', 'wet'],
    'select.robot_route': ['quick', 'standard', 'intensive', 'deep'],
    'select.robot_map': ['Map 1', 'Map 2']
  };
  for (var k in OPTS) put(k, ui.vacuum.settings[{ 'select.robot_cleaning_mode': 0, 'select.robot_suction_level': 1, 'select.robot_mop_humidity': 2, 'select.robot_route': 3, 'select.robot_map': 4 }[k]].usual, { options: OPTS[k] });
  put('button.robot_reset_sensor', 'unknown'); put('button.robot_shortcut', 'unknown');
  var PROGS = ['dishcare_dishwasher_program_eco_50', 'dishcare_dishwasher_program_auto_2', 'dishcare_dishwasher_program_quick_45', 'dishcare_dishwasher_program_quick_65',
    'dishcare_dishwasher_program_intensiv_70', 'dishcare_dishwasher_program_glas_40', 'dishcare_dishwasher_program_night_wash', 'dishcare_dishwasher_program_pre_rinse', 'dishcare_dishwasher_program_machine_care'];
  put('sensor.dishwasher_operation_state', 'ready'); put('sensor.dishwasher_door', 'closed');
  put('sensor.dishwasher_finish_time', 'unavailable'); put('sensor.dishwasher_progress', 'unavailable');
  put('binary_sensor.dishwasher_remote_start', 'on');
  put('select.dishwasher_selected_program', PROGS[0], { options: PROGS }); put('select.dishwasher_active_program', 'unknown', { options: PROGS });
  put('number.dishwasher_start_in_relative', '0', { min: 0, max: 86460, step: 60 });
  for (i = 0; i < ui.dishwasher.options.length; i++) put(ui.dishwasher.options[i].entity, 'off');
  // Like Home Connect: some options don't exist for the selected program
  put('switch.dishwasher_hygiene', 'unavailable');
  put('button.dishwasher_stop_program', 'unknown');
  put('script.ac_all_off', 'off'); put('script.good_night', 'off');
  put('binary_sensor.front_lawn_watering', 'off', {}, 30); put('binary_sensor.back_lawn_watering', 'off', {}, 6);
  put('sensor.lawn_next_cycle', iso(NOW + 42 * H));
  put('binary_sensor.internet', 'on'); put('sensor.wifi_devices', '23');
  put('sensor.nas_cpu_temperature', '52'); put('sensor.nas_drive_temperature', '39');
  for (i = 0; i < ui.cameras.length; i++) put(ui.cameras[i].entity, 'idle');

  var version = 1, waiters = [], delay = 0;
  function snapshot() { var t = Math.round(new Date().getTime() / 1000); return { v: version, ok: true, at: t, tz: -new Date().getTimezoneOffset(), dry: false, kindle: { b: 72, c: 0, at: t }, e: E }; }
  function set(id, s, attrs) {
    var x = E[id]; if (!x) return;
    x.s = s; x.c = Math.round(new Date().getTime() / 1000);
    if (attrs) for (var a in attrs) x.a[a] = attrs[a];
  }
  function bump() { version++; var w = waiters; waiters = []; for (var i = 0; i < w.length; i++) w[i](); }

  // Same verbs as the real proxy (see server.js); effects are a rough imitation of Home Assistant
  function action(b) {
    var id = b.e, v = b.v, x = E[id];
    switch (b['do']) {
      case 'power': set(id, v ? 'cool' : 'off', { temperature: v ? 24 : null }); break;
      case 'temperature': set(id, x.s, { temperature: Math.max(16, Math.min(30, +v)) }); break;
      case 'hvac_mode': set(id, v, { temperature: v === 'off' ? null : (x.a.temperature || 24) }); break;
      case 'fan_mode': set(id, x.s, { fan_mode: v }); break;
      case 'lock': set(id, 'locked'); break;
      case 'unlock': set(id, 'unlocked'); break;
      case 'start': set(id, 'cleaning'); break;
      case 'start_with': for (var sel in v) set(sel, v[sel]); set(id, 'cleaning'); break;
      case 'dock': set(id, 'returning'); setTimeout(function () { set(id, 'docked'); bump(); }, 4000); break;
      case 'select':
        if (id === ui.dishwasher.active) { set(ui.dishwasher.state, delay > 0 ? 'delayedstart' : 'run'); set(ui.dishwasher.selected, v); delay = 0; }
        else set(id, v);
        break;
      case 'switch': set(id, v ? 'on' : 'off'); break;
      case 'number': delay = +v; set(id, String(v)); break;
      case 'press':
        if (id === ui.vacuum.resetSensor) set(ui.vacuum.sensorDirty, '30');
        else if (id === ui.vacuum.shortcut.entity) set(ui.vacuum.entity, 'cleaning');
        else if (id === ui.dishwasher.stop) set(ui.dishwasher.state, 'ready');
        break;
      case 'run':
        var off = id === 'script.ac_all_off' ? ROOMS : [ROOMS[0], ROOMS[2], ROOMS[3], ROOMS[4]];
        for (var i = 0; i < off.length; i++) set('climate.' + off[i][0], 'off', { temperature: null });
        if (id === 'script.good_night') set(ui.lock.entity, 'locked');
        break;
    }
    // WHY: a short pause makes the "sending" state visible, like a real round trip to Home Assistant
    setTimeout(bump, 600);
    return { ok: true };
  }

  function FakeXHR() { this.readyState = 0; this.status = 0; this.responseText = ''; this._h = {}; }
  FakeXHR.prototype.open = function (m, url) { this._m = m; this._u = url; };
  FakeXHR.prototype.setRequestHeader = function (k, v) { this._h[k] = v; };
  FakeXHR.prototype.abort = function () { this._aborted = true; };
  FakeXHR.prototype._reply = function (obj) {
    if (this._aborted) return;
    this.readyState = 4; this.status = 200; this.responseText = JSON.stringify(obj);
    if (this.onreadystatechange) this.onreadystatechange();
  };
  FakeXHR.prototype.send = function (body) {
    var self = this, u = this._u, m = /[?&]v=(\d+)/.exec(u);
    if (u.indexOf('api/config') > -1) return setTimeout(function () { self._reply({ title: 'Inkhouse demo', ui: ui }); }, 50);
    if (u.indexOf('api/action') > -1) return setTimeout(function () { self._reply(action(JSON.parse(body))); }, 50);
    if (u.indexOf('api/state') > -1) {
      if (m && +m[1] === version) {
        var fn = function () { clearTimeout(t); self._reply(snapshot()); };
        var t = setTimeout(function () { waiters = waiters.filter(function (w) { return w !== fn; }); self._reply(snapshot()); }, 25000);
        waiters.push(fn);
        return;
      }
      return setTimeout(function () { self._reply(snapshot()); }, 50);
    }
  };
  window.XMLHttpRequest = FakeXHR;
})();
