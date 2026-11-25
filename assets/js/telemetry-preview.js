/*
** Telemetry query preview module for Zabbix.
** Copyright (C) 2026 Telemetry query preview module contributors
**
** This program is free software: you can redistribute it and/or modify it under the terms of
** the GNU Affero General Public License as published by the Free Software Foundation, version 3.
**
** This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
** without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
** See the GNU Affero General Public License for more details.
**
** You should have received a copy of the GNU Affero General Public License along with this program.
** If not, see <https://www.gnu.org/licenses/>.
**
** SPDX-License-Identifier: AGPL-3.0-only
*/

/**
 * Adds a "Collection preview" row below the Granularity field of telemetry query item, item prototype and
 * discovery rule forms. The preview simulates the Zabbix server logic for the processing window
 * (src/libs/zbxtelemetry/telemetry_query.c, tq_get_timestamp_filter_bounds_unshifted()):
 *
 *   if (granularity > now - lasttimestamp)        window = [now - granularity, now)             (hopping)
 *   else start = max(lasttimestamp, now - lookback) window = [start, start + whole buckets)     (tumbling)
 *   collected range = window - time shift;  next lasttimestamp = window end (unshifted)
 *   buckets are aligned to the window start: intDiv(ts - lower, granularity) * granularity + lower
 */
class TelemetryQueryPreview {

	static RUNS_SHOWN = 4;
	static RUNS_SIMULATED = 32;
	static MAX_BUCKETS_DRAWN = 120;
	static INSTANCES = new WeakMap();

	static LIMITS = {
		time_shift: [0, 86400],
		lookback_limit: [1, 3 * 86400],
		granularity: [1, 86400]
	};

	/**
	 * Find telemetry query forms in the document (popups are added dynamically) and attach a preview to each.
	 */
	static scan(root = document) {
		for (const granularity_field of root.querySelectorAll('#js-item-granularity-field')) {
			const form = granularity_field.closest('form');

			if (form !== null && !TelemetryQueryPreview.INSTANCES.has(form)
					&& form.querySelector('[name="granularity"]') !== null
					&& form.querySelector('[name="lookback_limit"]') !== null
					&& form.querySelector('[name="time_shift"]') !== null) {
				TelemetryQueryPreview.INSTANCES.set(form, new TelemetryQueryPreview(form, granularity_field));
			}
		}
	}

	constructor(form, granularity_field) {
		this.form = form;
		this.granularity_field = granularity_field;

		this.label = document.createElement('label');
		this.label.className = 'tqp-label';
		this.label.textContent = 'Collection preview';

		this.field = document.createElement('div');
		this.field.className = 'form-field tqp-field';
		this.field.setAttribute('aria-live', 'polite');

		granularity_field.after(this.label, this.field);

		const update = () => this.schedule();

		form.addEventListener('input', update);
		form.addEventListener('change', update);
		form.addEventListener('click', e => {
			if (e.target.closest('#delay-flex-table') !== null) {
				update();
			}
		});

		// Item type changes show/hide the telemetry fields: follow the visibility of the Granularity field.
		new MutationObserver(update).observe(granularity_field, {attributes: true, attributeFilter: ['style', 'class']});
		new MutationObserver(update).observe(form, {childList: true, subtree: true});

		this.render();
	}

	schedule() {
		if (this.pending) {
			return;
		}

		this.pending = true;

		requestAnimationFrame(() => {
			this.pending = false;
			this.render();
		});
	}

	// --- Input --------------------------------------------------------------------------------------------------

	static parseTimeUnit(value) {
		value = String(value ?? '').trim();

		if (value === '') {
			return {error: 'empty'};
		}

		if (/[{}$]/.test(value)) {
			return {error: 'macro'};
		}

		const match = value.match(/^(\d+)([smhdw]?)$/);

		if (match === null || (match[1].length > 1 && match[1][0] === '0')) {
			return {error: 'invalid'};
		}

		const multipliers = {'': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800};

		return {seconds: parseInt(match[1], 10) * multipliers[match[2]]};
	}

	readInput() {
		const get = name => this.form.querySelector(`[name="${name}"]`)?.value ?? '';
		const fields = {
			delay: 'Update interval',
			time_shift: 'Time shift',
			lookback_limit: 'Lookback limit',
			granularity: 'Granularity'
		};
		const values = {};
		const errors = [];

		for (const [name, label] of Object.entries(fields)) {
			const parsed = TelemetryQueryPreview.parseTimeUnit(get(name));

			if (parsed.error === 'macro') {
				errors.push(`${label} uses a user macro; the preview needs plain time values.`);
			}
			else if (parsed.error !== undefined) {
				if (name !== 'delay') {
					errors.push(`${label}: enter a time value, e.g. 30s, 5m, 1h.`);
				}
				values[name] = null;
			}
			else {
				values[name] = parsed.seconds;

				const limits = TelemetryQueryPreview.LIMITS[name];

				if (limits !== undefined && (parsed.seconds < limits[0] || parsed.seconds > limits[1])) {
					errors.push(`${label} must be between ${TelemetryQueryPreview.formatDuration(limits[0])} and `
						+ `${TelemetryQueryPreview.formatDuration(limits[1])}.`);
				}
			}
		}

		// Custom intervals: flexible ones change the update interval, scheduling ones are not simulated.
		const flexible = [];
		let has_scheduling = false;

		for (const row of this.form.querySelectorAll('#delay-flex-table .form_row')) {
			const type = row.querySelector('[name$="[type]"]:checked')?.value;

			if (type === '0') {
				const parsed = TelemetryQueryPreview.parseTimeUnit(row.querySelector('[name$="[delay]"]')?.value);

				if (parsed.seconds > 0) {
					flexible.push(parsed.seconds);
				}
			}
			else if (type === '1' && (row.querySelector('[name$="[schedule]"]')?.value ?? '').trim() !== '') {
				has_scheduling = true;
			}
		}

		if (values.delay === 0 || values.delay === null) {
			if (flexible.length > 0) {
				values.delay = flexible[0];
				values.delay_note = 'The update interval is 0; the preview uses the first flexible interval.';
			}
			else if (errors.length === 0) {
				errors.push(has_scheduling
					? 'The item uses only scheduling intervals; the preview needs an update interval.'
					: 'Update interval: enter a time value, e.g. 1m, 15m, 1h.');
			}
		}
		else if (flexible.length > 0 || has_scheduling) {
			values.delay_note = 'Custom intervals are not simulated; the preview uses the update interval.';
		}

		return {values, errors};
	}

	// --- Simulation (same arithmetic as the Zabbix server) -------------------------------------------------------

	static bounds(lookback, granularity, now, lasttimestamp) {
		if (lasttimestamp > now) {
			lasttimestamp = now;
		}

		if (granularity > now - lasttimestamp) {
			return {lower: now - granularity, upper: now, hopping: true};
		}

		const start = Math.max(lasttimestamp, now - lookback);

		return {lower: start, upper: start + Math.floor((now - start) / granularity) * granularity, hopping: false};
	}

	static simulate({delay, time_shift, lookback_limit, granularity}, now) {
		const runs = [];
		let lasttimestamp = 0;

		for (let i = TelemetryQueryPreview.RUNS_SIMULATED - 1; i >= 0; i--) {
			const run = now - i * delay;
			const window = TelemetryQueryPreview.bounds(lookback_limit, granularity, run, lasttimestamp);

			runs.push({
				run,
				...window,
				from: Math.max(window.lower - time_shift, 0),
				to: Math.max(window.upper - time_shift, 0),
				buckets: Math.round((window.upper - window.lower) / granularity)
			});

			lasttimestamp = window.upper;
		}

		return {
			runs: runs.slice(-TelemetryQueryPreview.RUNS_SHOWN),
			first: TelemetryQueryPreview.bounds(lookback_limit, granularity, now, 0)
		};
	}

	// --- Rendering ----------------------------------------------------------------------------------------------

	isVisible() {
		return this.granularity_field.isConnected && getComputedStyle(this.granularity_field).display !== 'none'
			&& !this.granularity_field.classList.contains('display-none');
	}

	render() {
		const visible = this.isVisible();

		this.label.style.display = visible ? '' : 'none';
		this.field.style.display = visible ? '' : 'none';

		if (!visible) {
			return;
		}

		const {values, errors} = this.readInput();
		const key = JSON.stringify([values, errors]);

		if (key === this.last_key) {
			return;
		}

		this.last_key = key;

		if (errors.length > 0) {
			this.field.replaceChildren(TelemetryQueryPreview.el('div', 'tqp-message', errors.join(' ')));

			return;
		}

		this.field.replaceChildren(this.build(values));
		TelemetryQueryPreview.fitLabels(this.field);
	}

	/**
	 * Hide texts that do not fit into their bar (the full text stays in the tooltip).
	 */
	static fitLabels(root) {
		for (const segment of root.querySelectorAll('.tqp-seg')) {
			for (const selector of ['.tqp-seg-time', '.tqp-seg-main']) {
				const text = segment.querySelector(selector);

				if (text !== null && segment.scrollWidth > segment.clientWidth + 1) {
					text.remove();
				}
			}
		}
	}

	build(values) {
		const el = TelemetryQueryPreview.el;
		const fd = TelemetryQueryPreview.formatDuration;
		const {delay, time_shift, lookback_limit, granularity} = values;

		// Example "now": the next run aligned to the update interval.
		const now = Math.ceil(Date.now() / 1000 / delay) * delay;
		const {runs, first} = TelemetryQueryPreview.simulate(values, now);
		const current = runs[runs.length - 1];

		// Time axis: everything that is drawn must fit; very long windows are drawn on a compressed axis.
		const recent_from = now - TelemetryQueryPreview.RUNS_SHOWN * delay;
		const domain_from = Math.min(recent_from, now - time_shift - lookback_limit, ...runs.map(r => r.from));
		const axis = TelemetryQueryPreview.makeAxis(domain_from, now, Math.min(recent_from, now - time_shift));
		const fmt = TelemetryQueryPreview.timeFormatter(now, [delay, time_shift, lookback_limit, granularity]);
		const range = (from, to) => {
			const day = t => new Date(t * 1000).toDateString();

			// Show the date on both ends when the range crosses midnight.
			return day(from) !== day(to) && day(from) !== day(now)
				? `${fmt(from)} – ${fmt(to, true)}`
				: `${fmt(from)} – ${fmt(to)}`;
		};

		const root = el('div', 'tqp');

		root.append(el('div', 'tqp-direction', [el('span', null, '← past'), el('span', null, 'now →')]));

		// 1. Update interval: the last runs.
		const runs_track = this.track(axis);

		runs.forEach((run, i) => {
			const is_current = i === runs.length - 1;
			this.segment(runs_track, axis, run.run - delay, run.run, is_current ? 'tqp-run tqp-current' : 'tqp-run',
				[fd(delay), `run ${fmt(run.run)}`],
				`${is_current ? 'Current run' : 'Run'} at ${fmt(run.run)} (update interval ${fd(delay)})`
			);
		});

		root.append(this.row('Update interval', fd(delay), runs_track));

		// 2. Time shift.
		const shift_track = this.track(axis, true);

		if (time_shift > 0) {
			this.segment(shift_track, axis, now - time_shift, now, 'tqp-shift', [fd(time_shift), range(now - time_shift, now)],
				`Time shift ${fd(time_shift)}: the newest ${fd(time_shift)} (${range(now - time_shift, now)}) is not collected yet`
			);
		}
		else {
			shift_track.append(el('span', 'tqp-track-note', 'no time shift'));
		}

		root.append(this.row('Time shift', fd(time_shift), shift_track));

		// 3. Lookback limit (the maximum reach of one run).
		const lookback_track = this.track(axis, true);

		this.segment(lookback_track, axis, now - time_shift - lookback_limit, now - time_shift, 'tqp-lookback',
			[fd(lookback_limit), range(now - time_shift - lookback_limit, now - time_shift)],
			`Lookback limit ${fd(lookback_limit)}: a run never reads data older than `
				+ `${range(now - time_shift - lookback_limit, now - time_shift)}`
		);
		this.placeholder(lookback_track, axis, now, time_shift);
		root.append(this.row('Lookback limit', fd(lookback_limit), lookback_track));

		// 4. Granularity: buckets collected by the shown runs (current run highlighted).
		const bucket_track = this.track(axis, true);

		for (const run of runs) {
			const is_current = run === current;

			if (run.to <= run.from) {
				continue;
			}

			if (run.buckets <= TelemetryQueryPreview.MAX_BUCKETS_DRAWN
					&& (axis.x(run.to) - axis.x(run.from)) / run.buckets >= 0.35) {
				for (let b = 0; b < run.buckets; b++) {
					const from = run.from + b * granularity;

					this.segment(bucket_track, axis, from, from + granularity,
						`tqp-bucket${is_current ? ' tqp-current' : ''}`,
						run.buckets === 1 ? [fd(granularity), range(from, from + granularity)] : [],
						`Bucket ${range(from, from + granularity)}${is_current ? ' (current run)' : ` (run at ${fmt(run.run)})`}`
					);
				}
			}
			else {
				this.segment(bucket_track, axis, run.from, run.to, `tqp-bucket tqp-bucket-many${is_current ? ' tqp-current' : ''}`,
					[`${run.buckets} × ${fd(granularity)}`, range(run.from, run.to)],
					`${run.buckets} buckets of ${fd(granularity)}: ${range(run.from, run.to)}`
						+ (is_current ? ' (current run)' : ` (run at ${fmt(run.run)})`)
				);
			}
		}

		// Gaps between the ranges of consecutive runs.
		for (let i = 1; i < runs.length; i++) {
			const gap_from = runs[i - 1].to;
			const gap_to = runs[i].from;

			if (gap_to > gap_from && runs[i].to > runs[i].from) {
				this.segment(bucket_track, axis, gap_from, gap_to, 'tqp-gap', [`${fd(gap_to - gap_from)} gap`],
					`Not collected: ${range(gap_from, gap_to)}`
				);
			}
		}

		this.placeholder(bucket_track, axis, now, time_shift);
		root.append(this.row('Granularity', fd(granularity), bucket_track));

		// Summary.
		root.append(this.summary(values, runs, first, now, fmt, range));

		return root;
	}

	summary({delay, time_shift, lookback_limit, granularity, delay_note}, runs, first, now, fmt, range) {
		const el = TelemetryQueryPreview.el;
		const fd = TelemetryQueryPreview.formatDuration;
		const current = runs[runs.length - 1];
		const previous = runs[runs.length - 2];
		const lines = [];

		const add = (text, type = 'info') => lines.push(el('li', `tqp-${type}`, text));

		if (current.to <= current.from) {
			add(`No data is collected: the lookback limit (${fd(lookback_limit)}) is shorter than the granularity `
				+ `(${fd(granularity)}), so a run never contains a whole bucket.`, 'warning');
		}
		else {
			add(el('span', null, [
				'Run at ', el('strong', null, fmt(current.run)), ' collects ',
				el('strong', null, range(current.from, current.to)), ` · ${current.buckets} × ${fd(granularity)} `
					+ `bucket${current.buckets === 1 ? '' : 's'}`
					+ (time_shift > 0 ? ` · ${fd(time_shift)} behind the run time` : '')
			]));

			const gap = current.lower - previous.upper;

			if (gap > 0) {
				add(`${fd(gap)} gap between the ranges of consecutive runs: data in the gaps is never collected `
					+ `(lookback limit ${fd(lookback_limit)} < update interval ${fd(delay)}).`, 'warning');
			}
			else if (gap < 0) {
				add(`${fd(-gap)} overlap between consecutive runs: the same data is aggregated again on every run `
					+ `(granularity ${fd(granularity)} > update interval ${fd(delay)}).`, 'warning');
			}
			else if (delay % granularity !== 0 && !current.hopping) {
				add(`Continuous, no gaps or overlap. The update interval is not a multiple of the granularity, so runs `
					+ `collect a varying number of buckets; the remainder is collected by the next run.`);
			}
			else {
				add('Continuous: consecutive runs collect adjacent ranges, no gaps and no overlap.', 'ok');
			}
		}

		if (first.upper > first.lower) {
			add(`First run after the item is created or changed collects up to the lookback limit: `
				+ `${range(Math.max(first.lower - time_shift, 0), Math.max(first.upper - time_shift, 0))}.`);
		}

		if (lookback_limit > delay && granularity <= delay) {
			add(`After an interruption, the next run catches up at most ${fd(lookback_limit)} of missed data; `
				+ `anything older is skipped.`);
		}

		if (delay_note !== undefined) {
			add(delay_note);
		}

		add('Times are an example based on the next run aligned to the update interval; the server decides the '
			+ 'actual schedule.', 'muted');

		return el('ul', 'tqp-summary', lines);
	}

	// --- Drawing helpers ----------------------------------------------------------------------------------------

	row(label, value, track) {
		const el = TelemetryQueryPreview.el;

		return el('div', 'tqp-row', [
			el('span', 'tqp-row-label', [label, el('span', 'tqp-row-value', value)]),
			track
		]);
	}

	track(axis, hatched = false) {
		const track = TelemetryQueryPreview.el('div', `tqp-track${hatched ? ' tqp-hatched' : ''}`);

		if (axis.break !== null) {
			track.append(TelemetryQueryPreview.el('span', 'tqp-break-line', null, {style: `left: ${axis.break}%`}));
		}

		return track;
	}

	segment(track, axis, from, to, cls, texts, title) {
		const left = axis.x(from);
		const width = Math.max(axis.x(to) - left, 0.25);
		const el = TelemetryQueryPreview.el;
		const segment = el('div', `tqp-seg ${cls}`, texts.length > 0
			? [el('span', 'tqp-seg-main', texts[0]), texts[1] !== undefined ? el('span', 'tqp-seg-time', texts[1]) : null]
			: null,
			{style: `left: ${left}%; width: ${width}%`, title}
		);

		if (axis.break !== null && left < axis.break && left + width > axis.break) {
			segment.append(el('span', 'tqp-break', '//', {style: `left: ${(axis.break - left) / width * 100}%`}));
		}

		track.append(segment);
	}

	placeholder(track, axis, now, time_shift) {
		if (time_shift > 0) {
			track.append(TelemetryQueryPreview.el('div', 'tqp-seg tqp-shift-ghost', null, {
				style: `left: ${axis.x(now - time_shift)}%; width: ${axis.x(now) - axis.x(now - time_shift)}%`,
				title: 'Time shift: not collected yet'
			}));
		}
	}

	/**
	 * Linear axis, or a broken axis when the far past would squeeze the recent runs into a few pixels.
	 */
	static makeAxis(from, to, recent_from) {
		const span = Math.max(to - from, 1);
		const recent = Math.max(to - recent_from, 1);

		if (from >= recent_from || span <= recent * 3) {
			return {x: t => (t - from) / span * 100, break: null};
		}

		const split = 30;

		return {
			x: t => t <= recent_from
				? (t - from) / Math.max(recent_from - from, 1) * split
				: split + (t - recent_from) / recent * (100 - split),
			break: split / 2
		};
	}

	static timeFormatter(now, durations) {
		const with_seconds = durations.some(d => d % 60 !== 0);
		const time = new Intl.DateTimeFormat(undefined, {
			hour: '2-digit', minute: '2-digit', ...(with_seconds ? {second: '2-digit'} : {}), hour12: false
		});
		const date = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
		const today = new Date(now * 1000).toDateString();

		return (t, with_date = false) => {
			const d = new Date(t * 1000);

			return d.toDateString() === today && !with_date ? time.format(d) : `${date.format(d)} ${time.format(d)}`;
		};
	}

	static formatDuration(seconds) {
		if (seconds === 0) {
			return '0';
		}

		const units = [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
		const parts = [];

		for (const [unit, size] of units) {
			if (seconds >= size) {
				parts.push(`${Math.floor(seconds / size)}${unit}`);
				seconds %= size;
			}
		}

		return parts.join(' ');
	}

	static el(tag, cls = null, children = null, attributes = {}) {
		const node = document.createElement(tag);

		if (cls !== null) {
			node.className = cls;
		}

		for (const [name, value] of Object.entries(attributes)) {
			node.setAttribute(name, value);
		}

		for (const child of [].concat(children ?? [])) {
			if (child !== null && child !== undefined) {
				node.append(child instanceof Node ? child : String(child));
			}
		}

		return node;
	}
}

(() => {
	const start = () => {
		TelemetryQueryPreview.scan();

		new MutationObserver(mutations => {
			if (mutations.some(m => m.addedNodes.length > 0)) {
				TelemetryQueryPreview.scan();
			}
		}).observe(document.body, {childList: true, subtree: true});
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	}
	else {
		start();
	}
})();
