"use strict";
/**
 * 业务工具接口（与 PeerStreamEnterprise 的 /api/pathfinder、/api/coordinatecovert 请求/响应格式兼容）
 *
 * 路网寻路：roadNet.points[{ id, location:"X=..,Y=..,Z=.." }]，roadNet.lines[{ linkIds:"id1,id2" }]，
 *          routingPoints[{ rp_location:"X=..,Y=..,Z=.." }]（依次经过）。每个途经点先投影到最近的路段上，
 *          再沿路网求最短路径。返回 ResultPoints：["X=..,Y=..,Z=..", ...]（首尾为投影点，中间为路网节点原始坐标）。
 * 坐标转换：两组对应控制点（A1→B1、A2→B2）求相似变换（缩放+旋转+平移），把 CoordinateA[] 转换为 CoordinateB[]。
 */

function parseLocation(s) {
	const m = String(s ?? "").match(/X=(-?[\d.]+(?:e-?\d+)?)\s*,\s*Y=(-?[\d.]+(?:e-?\d+)?)\s*,\s*Z=(-?[\d.]+(?:e-?\d+)?)/i);
	if (!m) throw new Error(`坐标格式错误（应为 X=..,Y=..,Z=..）：${s}`);
	return { x: +m[1], y: +m[2], z: +m[3] };
}
const fmtLoc = (p, z) => `X=${p.x.toFixed(2)},Y=${p.y.toFixed(2)},Z=${z.toFixed(2)}`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 点到线段的投影 */
function projectOnSegment(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
	const point = { x: a.x + t * dx, y: a.y + t * dy };
	return { point, d: dist(p, point) };
}

/** 最小堆（Dijkstra 用） */
class Heap {
	constructor() {
		this.a = [];
	}
	push(k, v) {
		const a = this.a;
		a.push([k, v]);
		let i = a.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (a[p][0] <= a[i][0]) break;
			[a[p], a[i]] = [a[i], a[p]];
			i = p;
		}
	}
	pop() {
		const a = this.a;
		const top = a[0];
		const last = a.pop();
		if (a.length) {
			a[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < a.length && a[l][0] < a[m][0]) m = l;
				if (r < a.length && a[r][0] < a[m][0]) m = r;
				if (m === i) break;
				[a[m], a[i]] = [a[i], a[m]];
				i = m;
			}
		}
		return top;
	}
	get size() {
		return this.a.length;
	}
}

class RoadNetwork {
	constructor(points, lines) {
		if (!Array.isArray(points) || !points.length) throw new Error("roadNet.points 不能为空");
		if (!Array.isArray(lines) || !lines.length) throw new Error("roadNet.lines 不能为空");
		if (points.length > 200000 || lines.length > 400000) throw new Error("路网规模过大");
		this.nodes = new Map();
		for (const p of points) {
			if (p?.id === undefined || p.id === null) throw new Error("路网节点缺少 id");
			this.nodes.set(String(p.id), { ...parseLocation(p.location), location: p.location });
		}
		this.adj = new Map();
		this.segments = [];
		for (const l of lines) {
			const ids = String(l?.linkIds ?? "").split(",").map((s) => s.trim());
			if (ids.length !== 2) throw new Error(`linkIds 格式错误（应为 "id1,id2"）：${l?.linkIds}`);
			const [a, b] = ids;
			if (!this.nodes.has(a) || !this.nodes.has(b)) throw new Error(`路段引用了不存在的节点：${a} -> ${b}`);
			const w = dist(this.nodes.get(a), this.nodes.get(b));
			this.addEdge(a, b, w);
			this.addEdge(b, a, w);
			this.segments.push([a, b]);
		}
	}
	addEdge(a, b, w) {
		if (!this.adj.has(a)) this.adj.set(a, []);
		this.adj.get(a).push([b, w]);
	}
	/** 投影到最近的路段 */
	project(p) {
		let best = null;
		for (const [a, b] of this.segments) {
			const pr = projectOnSegment(p, this.nodes.get(a), this.nodes.get(b));
			if (!best || pr.d < best.d) best = { ...pr, a, b };
		}
		return best;
	}
	/** 从投影点 s 到投影点 e 的最短路径（返回中间经过的节点 ID） */
	route(s, e) {
		const START = "\u0000S";
		const END = "\u0000E";
		const extra = new Map([[START, [[s.a, dist(s.point, this.nodes.get(s.a))], [s.b, dist(s.point, this.nodes.get(s.b))]]]]);
		const toEnd = new Map([
			[e.a, dist(e.point, this.nodes.get(e.a))],
			[e.b, dist(e.point, this.nodes.get(e.b))],
		]);
		const sameSeg = (s.a === e.a && s.b === e.b) || (s.a === e.b && s.b === e.a);
		if (sameSeg) extra.get(START).push([END, dist(s.point, e.point)]);
		const best = new Map([[START, 0]]);
		const prev = new Map();
		const heap = new Heap();
		heap.push(0, START);
		while (heap.size) {
			const [d, u] = heap.pop();
			if (u === END) break;
			if (d > (best.get(u) ?? Infinity)) continue;
			const edges = [...(extra.get(u) || []), ...(this.adj.get(u) || [])];
			if (toEnd.has(u)) edges.push([END, toEnd.get(u)]);
			for (const [v, w] of edges) {
				const nd = d + w;
				if (nd < (best.get(v) ?? Infinity)) {
					best.set(v, nd);
					prev.set(v, u);
					heap.push(nd, v);
				}
			}
		}
		if (!prev.has(END)) throw new Error("途经点之间没有连通的道路");
		const path = [];
		for (let v = prev.get(END); v && v !== START; v = prev.get(v)) path.unshift(v);
		return { path, length: best.get(END) };
	}
}

function pathfind(body) {
	const rps = body?.routingPoints;
	if (!Array.isArray(rps) || rps.length < 2) throw new Error("routingPoints 至少需要两个途经点");
	const net = new RoadNetwork(body?.roadNet?.points, body?.roadNet?.lines);
	const out = [];
	let total = 0;
	for (let i = 0; i + 1 < rps.length; i++) {
		const a = parseLocation(rps[i].rp_location);
		const b = parseLocation(rps[i + 1].rp_location);
		const pa = net.project(a);
		const pb = net.project(b);
		const { path, length } = net.route(pa, pb);
		total += length;
		if (i === 0) out.push(fmtLoc(pa.point, a.z));
		for (const id of path) out.push(net.nodes.get(id).location);
		out.push(fmtLoc(pb.point, b.z));
	}
	const ResultPoints = out.filter((p, i) => i === 0 || p !== out[i - 1]);
	return { status: 0, message: "success", ResultPoints, length: +total.toFixed(2) };
}

function coordinateConvert(body) {
	const { CoordinateA1: a1, CoordinateA2: a2, CoordinateB1: b1, CoordinateB2: b2, CoordinateA } = body || {};
	const ok = (p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.y);
	if (!ok(a1) || !ok(a2) || !ok(b1) || !ok(b2) || !Array.isArray(CoordinateA)) throw Object.assign(new Error("Missing required coordinate data"), { status: 400 });
	const dxA = a2.x - a1.x;
	const dyA = a2.y - a1.y;
	const dxB = b2.x - b1.x;
	const dyB = b2.y - b1.y;
	const lenA = Math.hypot(dxA, dyA);
	if (!lenA) throw Object.assign(new Error("CoordinateA1 与 CoordinateA2 不能重合"), { status: 400 });
	const scale = Math.hypot(dxB, dyB) / lenA;
	const theta = Math.atan2(dxA * dyB - dyA * dxB, dxA * dxB + dyA * dyB);
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const T = { a: scale * cos, b: -scale * sin, c: b1.x - (a1.x * scale * cos - a1.y * scale * sin), d: scale * sin, e: scale * cos, f: b1.y - (a1.x * scale * sin + a1.y * scale * cos) };
	if (CoordinateA.length > 100000) throw Object.assign(new Error("点数过多"), { status: 400 });
	const CoordinateB = CoordinateA.map((p) => ({ x: T.a * p.x + T.b * p.y + T.c, y: T.d * p.x + T.e * p.y + T.f }));
	return { status: 0, message: "success", CoordinateB };
}

module.exports = { pathfind, coordinateConvert, RoadNetwork, parseLocation };
