"5.2.0-tcp-relay";
/**
 * peer-stream.js —— UE 像素流浏览器 SDK（开源版 / 企业版通用）
 *
 * 用法： <script src="peer-stream.js"></script>
 *        <video is="peer-stream" id="wss://example.com/ws"></video>   id 省略时使用当前页面地址
 *
 * TCP 中继（无 UDP）相关的可选配置，优先级从高到低：
 *   1. window.PEER_STREAM_CONFIG = { iceServers, iceTransportPolicy, iceConfigUrl }
 *   2. <video is="peer-stream" ice-config="/__ice">  连接前 GET 该地址获取 {iceServers, iceTransportPolicy}
 *   3. 信令下发的 seticeServers 消息（开源版 signal.js 会附带 TURN 临时凭据与 iceTransportPolicy）
 *   另：<video is="peer-stream" relay> 或页面地址带 ?relay=1 时强制 iceTransportPolicy = "relay"
 */

// Must be kept in sync with JavaScriptKeyCodeToFKey C++ array.
// special keycodes different from KeyboardEvent.keyCode
const SpecialKeyCodes = {
	Backspace: 8,
	ShiftLeft: 16,
	ControlLeft: 17,
	AltLeft: 18,
	ShiftRight: 253,
	ControlRight: 254,
	AltRight: 255,
};

// https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button
const MouseButton = {
	MainButton: 0, // Left button.
	AuxiliaryButton: 1, // Wheel button.
	SecondaryButton: 2, // Right button.
	FourthButton: 3, // Browser Back button.
	FifthButton: 4, // Browser Forward button.
};

// https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons#value
const MouseButtonsMask = {
	1: 0,
	2: 2,
	4: 1,
	8: 3,
	16: 4,
};

// Must be kept in sync with PixelStreamingProtocol::EToClientMsg C++ enum.
const RECEIVE = {
	QualityControlOwnership: 0,
	Response: 1,
	Command: 2,
	FreezeFrame: 3,
	UnfreezeFrame: 4,
	VideoEncoderAvgQP: 5,
	LatencyTest: 6,
	InitialSettings: 7,
	FileExtension: 8,
	FileMimeType: 9,
	FileContents: 10,
	InputControlOwnership: 12,
	CompositionStart: 64,
	Protocol: 255,
};

// Must be kept in sync with PixelStreamingProtocol::EToUE4Msg C++ enum.
const SEND = {
	/*
	 * Control Messages. Range = 0..49.
	 */
	IFrameRequest: 0,
	RequestQualityControl: 1,
	FpsRequest: 2,
	AverageBitrateRequest: 3,
	StartStreaming: 4,
	StopStreaming: 5,
	LatencyTest: 6,
	RequestInitialSettings: 7,
	/*
	 * Input Messages. Range = 50..89.
	 */

	// Generic Input Messages. Range = 50..59.
	UIInteraction: 50,
	Command: 51,

	// Keyboard Input Message. Range = 60..69.
	KeyDown: 60,
	KeyUp: 61,
	KeyPress: 62,
	FindFocus: 63,
	CompositionEnd: 64,

	// Mouse Input Messages. Range = 70..79.
	MouseEnter: 70,
	MouseLeave: 71,
	MouseDown: 72,
	MouseUp: 73,
	MouseMove: 74,
	MouseWheel: 75,

	// Touch Input Messages. Range = 80..89.
	TouchStart: 80,
	TouchEnd: 81,
	TouchMove: 82,

	// Gamepad Input Messages. Range = 90..99
	GamepadButtonPressed: 90,
	GamepadButtonReleased: 91,
	GamepadAnalog: 92,
};

let iceServers = undefined;
let iceTransportPolicy = undefined;

class PeerStream extends HTMLVideoElement {
	constructor() {
		super();

		window.ps = this;

		this.ws = { send() {}, close() {} }; // WebSocket
		this.pc = { close() {} }; // RTCPeerConnection
		this.dc = null; // RTCDataChannel

		this.setupVideo();
		this.registerKeyboardEvents();
		this.registerMouseHoverEvents();
		this.registerFakeMouseEvents();

		document.addEventListener(
			"pointerlockchange",
			() => {
				if (document.pointerLockElement === this) {
					this.registerPointerLockEvents();
				} else {
					this.registerMouseHoverEvents();
				}
			},
			false
		);

		this.addEventListener("loadeddata", (e) => {
			this.style["aspect-ratio"] = this.videoWidth / this.videoHeight;
		});
	}

	checkWebRTCSupport() {
		const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
		if (!RTCPeerConnection) {
			console.warn("checkWebRTCSupport RTCPeerConnection not supported");
			return false;
		}
		try {
			const pc = new RTCPeerConnection();
			const dc = pc.createDataChannel("test");
			const ok = !!dc;
			dc.close();
			pc.close();
			if (!ok) console.warn("checkWebRTCSupport DataChannel not supported");
			return ok;
		} catch (e) {
			console.error(e);
			console.warn("checkWebRTCSupport dataChannelSupported not supported");
			return false;
		}
	}

	/** 信令地址：id 属性优先；否则用当前页面地址（去掉 #hash，旧浏览器带 hash 会直接抛 SyntaxError） */
	signalUrl() {
		if (this.id) return this.id;
		const url = new URL(location.href);
		url.hash = "";
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return url.href;
	}

	/** 是否强制只走 TURN 中继（TCP/TLS） */
	forceRelay() {
		if (this.hasAttribute("relay")) return true;
		if (this.getAttribute("ice-transport-policy") === "relay") return true;
		return /[?&](relay|forceRelay)=(1|true)\b/i.test(location.search);
	}

	/** 合并出最终的 RTCPeerConnection ICE 配置 */
	rtcConfig() {
		const g = window.PEER_STREAM_CONFIG || {};
		const servers = g.iceServers || this.iceOverride?.iceServers || iceServers;
		let policy = g.iceTransportPolicy || this.iceOverride?.iceTransportPolicy || iceTransportPolicy;
		if (this.forceRelay()) policy = "relay";
		const hasTurn = (servers || []).some((s) => [].concat(s.urls || s.url || []).some((u) => /^turns?:/i.test(u)));
		if (policy === "relay" && !hasTurn) {
			console.warn("iceTransportPolicy=relay 但没有 TURN 服务器，已回退为 all");
			policy = "all";
		}
		const config = { sdpSemantics: "unified-plan", bundlePolicy: "balanced", iceServers: servers };
		if (policy) config.iceTransportPolicy = policy;
		return config;
	}

	async loadIceOverride() {
		const url = (window.PEER_STREAM_CONFIG || {}).iceConfigUrl || this.getAttribute("ice-config");
		if (!url) return;
		try {
			const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
			if (res.ok) this.iceOverride = await res.json();
			console.log("↓↓ ice-config:", this.iceOverride);
		} catch (e) {
			console.warn("ice-config 获取失败，使用信令下发的配置", e);
		}
	}

	// setupWebsocket
	async connectedCallback() {
		this._destroyed = false;
		if (false == this.checkWebRTCSupport()) {
			const overlayDiv = document.createElement("div");
			overlayDiv.innerHTML = "你的浏览器版本过低!<br>推荐使用谷歌100以上版本浏览器!!";
			Object.assign(overlayDiv.style, {
				position: "absolute",
				top: "50%",
				left: "50%",
				transform: "translate(-50%, -50%)",
				background: "rgba(255, 255, 255, 0.8)",
				padding: "10px",
				borderRadius: "5px",
				display: "block",
			});
			this.parentNode?.appendChild(overlayDiv);
		}

		// This will happen each time the node is moved, and may happen before the element"s contents have been fully parsed.
		if (!this.isConnected) return;
		if (this.pc.connectionState === "connected" && this.dc?.readyState === "open" && this.ws.readyState === 1) {
			this.play();
			return;
		}
		await this.loadIceOverride();
		if (!this.isConnected || this._destroyed) return;

		this.ws.onclose = null;
		this.ws.close(1000);
		this.ws = new WebSocket(this.signalUrl(), "peer-stream");

		this.ws.onopen = () => {
			console.info("✅", this.ws);
		};

		this.ws.onmessage = (e) => {
			this.onWebSocketMessage(e.data);
		};

		this.ws.onclose = (e) => {
			console.warn(e);
			this.dispatchEvent(new CustomEvent("playerdisconnected", {}));
			clearTimeout(this.reconnect);
			if (this._destroyed) return;
			this.reconnect = setTimeout(() => this.connectedCallback(), this.nextRetryDelay());
		};
	}

	/** 重连退避：1s→2s→4s…上限 15s，并加 ±50% 抖动，避免服务重启后所有浏览器同一时刻涌入 */
	nextRetryDelay() {
		const n = Math.min(this.retries || 0, 4);
		this.retries = (this.retries || 0) + 1;
		const base = Math.min(15000, 1000 * 2 ** n);
		return Math.round(base * (0.5 + Math.random()));
	}

	disconnectedCallback() {
		// lifecycle binding
		setTimeout(() => {
			if (this.isConnected) return;
			this._destroyed = true; // 元素被移除后不再自动重连
			clearTimeout(this.reconnect);
			clearInterval(this.qosTimer);
			this.ws.onclose = null;
			this.ws.close(1000);
			this.pc.close();
			console.log("❌ peer connection closing");
		}, 5 * 1000);
	}

	adoptedCallback() {}

	attributeChangedCallback(name, oldValue, newValue) {
		if (!this.isConnected) return;
		// fired before connectedCallback when startup
		this.ws.close(1000);
	}

	async onWebSocketMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch {
			console.debug("↓↓", msg);
			return;
		}
		try {
			await this.handleSignal(msg);
		} catch (e) {
			console.error("signal handling error:", msg.type, e);
		}
	}

	async handleSignal(msg) {
		if (msg.type === "offer") {
			this.setupPeerConnection();

			const offer = new RTCSessionDescription(msg);
			console.log("↓↓ offer", offer);

			await this.pc.setRemoteDescription(offer);

			// Setup a transceiver for getting UE video
			this.pc.addTransceiver("video", { direction: "recvonly" });

			const answer = await this.pc.createAnswer();
			await this.pc.setLocalDescription(answer);

			console.log("↑↑ answer", answer);
			this.ws.send(JSON.stringify(answer));

			for (let receiver of this.pc.getReceivers()) {
				receiver.playoutDelayHint = 0;
			}
		} else if (msg.type === "iceCandidate") {
			if (!(this.pc instanceof RTCPeerConnection) || !msg.candidate) return;
			const candidate = new RTCIceCandidate(msg.candidate);
			console.log("↓↓ candidate:", candidate);
			await this.pc.addIceCandidate(candidate).catch((e) => console.warn("addIceCandidate failed", e));
		} else if (msg.type === "answer") {
			const answer = new RTCSessionDescription(msg);
			await this.pc.setRemoteDescription(answer);
			console.log("↓↓ answer:", answer);
			for (const receiver of this.pc.getReceivers()) {
				receiver.playoutDelayHint = 0;
			}
		} else if (msg.type === "playerqueue") {
			this.dispatchEvent(new CustomEvent("playerqueue", { detail: msg }));
			console.log("↓↓ playerqueue:", msg);
		} else if (msg.type === "seticeServers") {
			iceServers = msg.iceServers;
			iceTransportPolicy = msg.iceTransportPolicy;
			console.log("↓↓ seticeServers:", msg);
			// ps-platform 会带 qos 字段（毫秒），表示希望浏览器定期上报播放质量；旧版信令不带，不上报
			if (msg.qos > 0) this.startQosReporting(msg.qos);
		} else if (msg.type === "playerConnected") {
			console.log("↓↓ playerConnected:", msg);
			this.setupPeerConnection_ue4();
			this.setupDataChannel_ue4();
		} else if (msg.type === "ping") {
			console.log("↓↓ ping:", msg);
			msg.type = "pong";
			this.ws.send(JSON.stringify(msg));

			if (this.mouseReleaseTime) {
				let now = new Date();
				if (now - this.lastmouseTime > this.mouseReleaseTime * 1000) {
					msg.type = "mouseRelease";
					this.ws.send(JSON.stringify(msg));
				}
			}
		} else if (msg.type === "ueDisConnected") {
			this.dispatchEvent(new CustomEvent("ueDisConnected", { detail: msg }));
			console.log("↓↓ ueDisConnected:", msg);
		} else if (msg.type === "setmouseReleaseTime") {
			this.mouseReleaseTime = msg.mouseReleaseTime;
			this.lastmouseTime = new Date();
			console.log("↓↓ setmouseReleaseTime:", msg);
		} else if (msg.type === "playerConfig") {
			// ps-platform 下发的播放页配置（隐藏鼠标、程序名称、无操作释放时间等）
			this.playerConfig = msg;
			if (msg.hideCursor) this.style.cursor = "none";
			this.dispatchEvent(new CustomEvent("playerconfig", { detail: msg }));
		} else if (msg.type === "getStatus") {
			console.log("↓↓ getStatus:", msg);
			this.handleGetStatus(msg);
		} else {
			console.warn("↓↓", msg);
		}
	}

	handleGetStatus(msg) {
		if (false == this.pc instanceof RTCPeerConnection) {
			msg.videoencoderqp = null;
			msg.netrate = null;
			this.ws.send(JSON.stringify(msg));
			console.log("↑↑ handleGetStatus:", msg);
			return;
		}
		const pc = this.pc;
		const durationInSeconds = 0.5;
		const bytes = (stats) => {
			let n = 0;
			stats.forEach((report) => {
				if (report.type === "transport") n += report.bytesReceived || 0;
			});
			return n;
		};
		pc.getStats(null)
			.then((s1) => new Promise((res) => setTimeout(() => res(bytes(s1)), durationInSeconds * 1000)))
			.then(async (initial) => {
				const final = bytes(await pc.getStats(null));
				// 平均带宽（Mbps）
				msg.videoencoderqp = this.VideoEncoderQP;
				msg.netrate = ((((final - initial) / durationInSeconds) * 8) / 1000 / 1000).toFixed(2);
				this.ws.send(JSON.stringify(msg));
				console.log("↑↑ handleGetStatus:", msg);
			})
			.catch((e) => console.warn("getStats failed", e));
	}

	/** 当前选中的候选对：可用来确认是否真的走了 TURN/TCP（relay + tcp/tls） */
	/** 定期向平台上报播放质量：码率、帧率、RTT、丢包、分辨率、链路类型（用于管理端实时监控与会话记录） */
	startQosReporting(intervalMs) {
		if (this.qosTimer && this.qosInterval === intervalMs) return;
		clearInterval(this.qosTimer);
		this.qosInterval = intervalMs;
		let last = null;
		this.qosTimer = setInterval(async () => {
			if (!(this.pc instanceof RTCPeerConnection) || this.pc.connectionState !== "connected" || this.ws.readyState !== 1) return;
			try {
				const stats = await this.pc.getStats(null);
				let bytes = 0;
				let video = null;
				stats.forEach((r) => {
					if (r.type === "transport") bytes += r.bytesReceived || 0;
					if (r.type === "inbound-rtp" && (r.kind || r.mediaType) === "video") video = r;
				});
				const now = performance.now();
				const t = await this.getTransportInfo();
				const kbps = last ? Math.max(0, Math.round(((bytes - last.bytes) * 8) / (now - last.at))) : null;
				last = { bytes, at: now };
				if (kbps === null) return;
				this.ws.send(
					JSON.stringify({
						type: "stats",
						kbps,
						fps: video?.framesPerSecond ?? null,
						lost: video?.packetsLost ?? null,
						w: video?.frameWidth ?? null,
						h: video?.frameHeight ?? null,
						rtt: t?.rtt !== undefined ? Math.round(t.rtt * 1000) : null,
						transport: t ? `${t.localType}${t.localType === "relay" ? "/" + (t.relayProtocol || "udp") : ""}→${t.remoteType}` : null,
					})
				);
			} catch {}
		}, intervalMs);
	}

	async getTransportInfo() {
		if (!(this.pc instanceof RTCPeerConnection)) return null;
		const stats = await this.pc.getStats(null);
		let pair = null;
		stats.forEach((r) => {
			if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
		});
		if (!pair) stats.forEach((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded" && (pair = r));
		if (!pair) return null;
		const local = stats.get(pair.localCandidateId) || {};
		const remote = stats.get(pair.remoteCandidateId) || {};
		return {
			localType: local.candidateType,
			localProtocol: local.protocol,
			relayProtocol: local.relayProtocol, // "tcp" / "tls" 表示浏览器到 TURN 走的是 TCP
			localAddress: local.address || local.ip,
			remoteType: remote.candidateType,
			remoteAddress: (remote.address || remote.ip) + ":" + remote.port,
			rtt: pair.currentRoundTripTime,
		};
	}

	onDataChannelMessage(data) {
		data = new Uint8Array(data);
		const utf16 = new TextDecoder("utf-16");
		switch (data[0]) {
			case RECEIVE.VideoEncoderAvgQP: {
				this.VideoEncoderQP = +utf16.decode(data.slice(1));
				break;
			}
			case RECEIVE.Response: {
				// user custom message
				const detail = utf16.decode(data.slice(1));
				this.dispatchEvent(new CustomEvent("message", { detail }));
				console.info(detail);
				break;
			}
			case RECEIVE.Command: {
				const command = JSON.parse(utf16.decode(data.slice(1)));
				console.info("↓↓ command:", command);
				if (command.command === "onScreenKeyboard") {
					console.info("You should setup a on-screen keyboard");
					if (command.showOnScreenKeyboard && this.enableChinese) this.showImeInput();
				}
				break;
			}
			case RECEIVE.FreezeFrame: {
				const jpeg = data.slice(1 + 4);
				console.info("↓↓ freezed frame:", jpeg);
				break;
			}
			case RECEIVE.UnfreezeFrame: {
				console.info("↓↓ 【unfreeze frame】");
				break;
			}
			case RECEIVE.LatencyTest: {
				const latencyTimings = JSON.parse(utf16.decode(data.slice(1)));
				console.info("↓↓ latency timings:", latencyTimings);
				break;
			}
			case RECEIVE.QualityControlOwnership: {
				this.QualityControlOwnership = data[1] !== 0;
				console.info("↓↓ Quality Control Ownership:", this.QualityControlOwnership);
				break;
			}
			case RECEIVE.InitialSettings: {
				this.InitialSettings = JSON.parse(utf16.decode(data.slice(1)));
				console.log("↓↓ initial setting:", this.InitialSettings);
				break;
			}
			case RECEIVE.InputControlOwnership: {
				this.InputControlOwnership = data[1] !== 0;
				console.log("↓↓ input control ownership:", this.InputControlOwnership);
				break;
			}
			case RECEIVE.Protocol: {
				let protocol = JSON.parse(utf16.decode(data.slice(1)));
				console.log(protocol);
				if (protocol.Direction === 0) {
					for (let key in protocol) {
						SEND[key] = protocol[key].id;
					}
				} else if (protocol.Direction === 1) {
					for (let key in protocol) {
						RECEIVE[key] = protocol[key].id;
					}
				}

				this.send(new Uint8Array([SEND.RequestInitialSettings]));
				this.send(new Uint8Array([SEND.RequestQualityControl]));
				break;
			}
			default: {
				console.error("↓↓ invalid data:", data);
			}
		}
	}

	/** 中文输入：用隐藏的 input 承接输入法，组合结束后发给 UE */
	showImeInput() {
		if (this.imeInput) {
			this.imeInput.focus();
			return;
		}
		const input = document.createElement("input");
		input.style.position = "fixed";
		input.style.zIndex = -1;
		input.style.opacity = 0;
		input.autofocus = true;
		document.body.append(input);
		input.focus();
		input.addEventListener("compositionend", (e) => {
			console.log(e.data);
			this.emitMessage(e.data, SEND.CompositionEnd);
			input.value = "";
		});
		// 原版这里误写成 'blue'，导致 input 永远不会被移除、每次弹键盘都会堆积一个
		input.addEventListener("blur", () => {
			input.remove();
			this.imeInput = null;
		});
		input.addEventListener("keydown", (e) => this.onkeydown(e));
		input.addEventListener("keyup", (e) => this.onkeyup(e));
		input.addEventListener("keypress", (e) => this.onkeypress(e));
		this.imeInput = input;
	}

	setupVideo() {
		this.tabIndex = 0; // easy to focus..
		this.playsInline = true;
		this.disablepictureinpicture = true;

		// Recently many browsers can only autoplay the videos with sound off
		this.muted = true;
		this.autoplay = true;

		this.style["pointer-events"] = "none";
		this.style["object-fit"] = "fill";
	}

	/** 数据通道未就绪时静默丢弃，避免键鼠事件在连接前/断开后抛 InvalidStateError */
	send(data) {
		if (this.dc?.readyState !== "open") return false;
		this.lastmouseTime = new Date(); // 任何键鼠/触摸输入都算"有操作"（无操作自动释放功能使用）
		try {
			this.dc.send(data);
			return true;
		} catch (e) {
			console.warn("data channel send failed:", e.message);
			return false;
		}
	}

	setupDataChannel(e) {
		this.dc = e.channel;

		// Inform browser we would like binary data as an ArrayBuffer (FF chooses Blob by default!)
		this.dc.binaryType = "arraybuffer";

		this.dc.onopen = (e) => {
			console.log("✅", this.dc);
			this.style.pointerEvents = "auto";
		};

		this.dc.onclose = (e) => {
			console.info("❌ data channel closed");
			this.style.pointerEvents = "none";
			this.blur();
		};

		this.dc.onmessage = (e) => {
			this.onDataChannelMessage(e.data);
		};
	}

	setupDataChannel_ue4(label = "hello") {
		// See https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit for values (this is needed for Firefox to be consistent with Chrome.)
		this.dc = this.pc.createDataChannel(label, { ordered: true });
		// Inform browser we would like binary data as an ArrayBuffer (FF chooses Blob by default!)
		this.dc.binaryType = "arraybuffer";

		this.dc.onopen = (e) => {
			console.log("✅ data channel connected:", label);
			this.style.pointerEvents = "auto";
			this.send(new Uint8Array([SEND.RequestInitialSettings]));
			this.send(new Uint8Array([SEND.RequestQualityControl]));
		};

		this.dc.onclose = (e) => {
			console.info("❌ data channel closed:", label);
			this.style.pointerEvents = "none";
		};

		this.dc.onmessage = (e) => {
			this.onDataChannelMessage(e.data);
		};
	}

	createPeerConnection() {
		this.pc.close();
		const config = this.rtcConfig();
		console.log("RTCPeerConnection config:", config);
		const pc = new RTCPeerConnection(config);
		this.pc = pc;

		pc.ontrack = (e) => {
			console.log(`↓↓ ${e.track.kind} track:`, e);
			if (e.track.kind === "video") {
				this.srcObject = e.streams[0];
			} else if (e.track.kind === "audio") {
				this.audio = document.createElement("audio");
				this.audio.autoplay = true;
				this.audio.srcObject = e.streams[0];
			}
		};
		pc.onicecandidate = (e) => {
			// firefox
			if (e.candidate?.candidate) {
				console.log("↑↑ candidate:", e.candidate);
				this.ws.send(JSON.stringify({ type: "iceCandidate", candidate: e.candidate }));
			}
		};
		pc.onicecandidateerror = (e) => {
			// TURN 地址/凭据错误时这里会有 701/401 等错误码，便于排查
			console.warn("ICE candidate error:", e.url, e.errorCode, e.errorText);
		};
		pc.onconnectionstatechange = () => {
			if (pc !== this.pc) return;
			console.log("WebRTC connectionState:", pc.connectionState);
			this.dispatchEvent(new CustomEvent("connectionstatechange", { detail: pc.connectionState }));
			if (pc.connectionState === "connected") {
				this.retries = 0; // 媒体真正连通后才清零重试计数
				this.getTransportInfo().then((info) => info && console.log("✅ selected candidate pair:", info));
			}
			if (pc.connectionState === "failed") {
				// ICE 失败（例如 TURN 不通）：断开信令触发重连，让 UE 重新发起协商
				console.warn("WebRTC failed, reconnecting signaling...");
				this.dispatchEvent(new CustomEvent("webrtcfailed", {}));
				this.ws.close(1000);
			}
		};
		return pc;
	}

	setupPeerConnection() {
		const pc = this.createPeerConnection();
		pc.ondatachannel = (e) => {
			this.setupDataChannel(e);
		};
	}

	setupPeerConnection_ue4() {
		const pc = this.createPeerConnection();
		pc.onnegotiationneeded = (e) => {
			this.setupOffer();
		};
	}

	async setupOffer() {
		const offer = await this.pc.createOffer({
			offerToReceiveAudio: +this.hasAttribute("audio"),
			offerToReceiveVideo: 1,
			voiceActivityDetection: false,
		});

		// this indicate we support stereo (Chrome needs this)
		offer.sdp = offer.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1;sprop-maxcapturerate=48000");

		await this.pc.setLocalDescription(offer);

		this.ws.send(JSON.stringify(offer));
		console.log("↓↓ sending offer:", offer);
	}

	keysDown = new Set();

	registerKeyboardEvents() {
		this.onkeydown = (e) => {
			const keyCode = SpecialKeyCodes[e.code] || e.keyCode;
			this.send(new Uint8Array([SEND.KeyDown, keyCode, e.repeat]));
			this.keysDown.add(keyCode);

			// Backspace is not considered a keypress in JavaScript but we need it
			// to be so characters may be deleted in a UE text entry field.
			if (e.keyCode === SpecialKeyCodes.Backspace) {
				this.onkeypress({
					keyCode: SpecialKeyCodes.Backspace,
				});
			}
		};

		this.onkeyup = (e) => {
			const keyCode = SpecialKeyCodes[e.code] || e.keyCode;
			this.send(new Uint8Array([SEND.KeyUp, keyCode]));
			this.keysDown.delete(keyCode);
		};

		this.onkeypress = (e) => {
			const data = new DataView(new ArrayBuffer(3));
			data.setUint8(0, SEND.KeyPress);
			data.setUint16(1, SpecialKeyCodes[e.code] || e.charCode || e.keyCode, true);
			this.send(data);
		};

		this.onblur = (e) => {
			this.keysDown.forEach((keyCode) => {
				this.send(new Uint8Array([SEND.KeyUp, keyCode]));
			});
			this.keysDown.clear();
		};
	}

	registerTouchEvents() {
		// We need to assign a unique identifier to each finger.
		// We do this by mapping each Touch object to the identifier.
		const fingers = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
		const fingerIds = {};

		this.ontouchstart = (e) => {
			// Assign a unique identifier to each touch.
			for (const touch of e.changedTouches) {
				// remember touch
				const finger = fingers.pop();
				if (finger === undefined) {
					console.info("exhausted touch indentifiers");
				}
				fingerIds[touch.identifier] = finger;
			}
			this.emitTouchData(SEND.TouchStart, e.changedTouches, fingerIds);
			e.preventDefault();
		};

		this.ontouchend = (e) => {
			this.emitTouchData(SEND.TouchEnd, e.changedTouches, fingerIds);
			// Re-cycle unique identifiers previously assigned to each touch.
			for (const touch of e.changedTouches) {
				// forget touch
				fingers.push(fingerIds[touch.identifier]);
				delete fingerIds[touch.identifier];
			}
			e.preventDefault();
		};

		this.ontouchmove = (e) => {
			this.emitTouchData(SEND.TouchMove, e.touches, fingerIds);
			e.preventDefault();
		};
	}

	// touch as mouse
	registerFakeMouseEvents() {
		let finger = undefined;
		// 原版在构造函数里只取一次 getBoundingClientRect（此时元素尚未布局，恒为 0,0），导致触摸坐标偏移
		const rect = () => this.getBoundingClientRect();

		this.ontouchstart = (e) => {
			if (finger === undefined) {
				const { left, top } = rect();
				const firstTouch = e.changedTouches[0];
				finger = {
					id: firstTouch.identifier,
					x: firstTouch.clientX - left,
					y: firstTouch.clientY - top,
				};
				// Hack: Mouse events require an enter and leave so we just enter and leave manually with each touch as this event is not fired with a touch device.
				this.onmouseenter(e);
				this.emitMouseDown(MouseButton.MainButton, finger.x, finger.y);
			}
			e.preventDefault();
		};

		this.ontouchend = (e) => {
			// filtering multi finger touch events temporarily
			if (finger) {
				const { left, top } = rect();
				for (const touch of e.changedTouches) {
					if (touch.identifier === finger.id) {
						const x = touch.clientX - left;
						const y = touch.clientY - top;
						this.emitMouseUp(MouseButton.MainButton, x, y);
						// Hack: Manual mouse leave event.
						this.onmouseleave(e);
						finger = undefined;
						break;
					}
				}
			}
			e.preventDefault();
		};

		this.ontouchmove = (e) => {
			// filtering multi finger touch events temporarily
			if (finger) {
				const { left, top } = rect();
				for (const touch of e.touches) {
					if (touch.identifier === finger.id) {
						const x = touch.clientX - left;
						const y = touch.clientY - top;
						this.emitMouseMove(x, y, x - finger.x, y - finger.y);
						finger.x = x;
						finger.y = y;
						break;
					}
				}
			}
			e.preventDefault();
		};
	}

	registerMouseHoverEvents() {
		this.registerMouseEnterAndLeaveEvents();

		this.onmousemove = (e) => {
			this.emitMouseMove(e.offsetX, e.offsetY, e.movementX, e.movementY);
			e.preventDefault();
		};

		this.onmousedown = (e) => {
			// preventDefault 会阻止 video 获得焦点，导致键盘事件发不出去；这里手动聚焦
			this.focus({ preventScroll: true });
			this.emitMouseDown(e.button, e.offsetX, e.offsetY);
			e.preventDefault();
		};

		this.onmouseup = (e) => {
			this.emitMouseUp(e.button, e.offsetX, e.offsetY);
			e.preventDefault();
		};

		// 右键菜单：Linux/macOS 在 mousedown 时就触发 contextmenu，这里不能补发 mouseup，否则右键拖拽会中断
		this.oncontextmenu = (e) => {
			e.preventDefault();
			return false;
		};

		this.onwheel = (e) => {
			this.emitMouseWheel(e.wheelDelta, e.offsetX, e.offsetY);
			e.preventDefault();
		};
	}

	registerPointerLockEvents() {
		this.registerMouseEnterAndLeaveEvents();

		console.info("mouse locked in, ESC to exit");

		const { clientWidth, clientHeight } = this;
		let x = clientWidth / 2;
		let y = clientHeight / 2;

		this.onmousemove = (e) => {
			x += e.movementX;
			y += e.movementY;
			x = (x + clientWidth) % clientWidth;
			y = (y + clientHeight) % clientHeight;

			this.emitMouseMove(x, y, e.movementX, e.movementY);
		};

		this.onmousedown = (e) => {
			this.emitMouseDown(e.button, x, y);
		};

		this.onmouseup = (e) => {
			this.emitMouseUp(e.button, x, y);
		};

		this.onwheel = (e) => {
			this.emitMouseWheel(e.wheelDelta, x, y);
		};
	}

	registerMouseEnterAndLeaveEvents() {
		this.onmouseenter = (e) => {
			this.send(new Uint8Array([SEND.MouseEnter]));
		};

		this.onmouseleave = (e) => {
			this.send(new Uint8Array([SEND.MouseLeave]));
			// 释放掉
			for (let i = 1; i <= 16; i *= 2) {
				if (e.buttons & i) {
					this.emitMouseUp(MouseButtonsMask[i], 0, 0);
				}
			}
		};
	}

	emitMouseMove(x, y, deltaX, deltaY) {
		const coord = this.normalize(x, y);
		deltaX = (deltaX * 65536) / this.clientWidth;
		deltaY = (deltaY * 65536) / this.clientHeight;
		const data = new DataView(new ArrayBuffer(9));
		data.setUint8(0, SEND.MouseMove);
		data.setUint16(1, coord.x, true);
		data.setUint16(3, coord.y, true);
		data.setInt16(5, deltaX, true);
		data.setInt16(7, deltaY, true);
		this.send(data);
		this.lastmouseTime = new Date();
	}

	emitMouseDown(button, x, y) {
		const coord = this.normalize(x, y);
		const data = new DataView(new ArrayBuffer(6));
		data.setUint8(0, SEND.MouseDown);
		data.setUint8(1, button);
		data.setUint16(2, coord.x, true);
		data.setUint16(4, coord.y, true);
		this.send(data);
		if (this.enableChinese) {
			this.send(new Uint8Array([SEND.FindFocus]));
		}
	}

	emitMouseUp(button, x, y) {
		const coord = this.normalize(x, y);
		const data = new DataView(new ArrayBuffer(6));
		data.setUint8(0, SEND.MouseUp);
		data.setUint8(1, button);
		data.setUint16(2, coord.x, true);
		data.setUint16(4, coord.y, true);
		this.send(data);
	}

	emitMouseWheel(delta, x, y) {
		const coord = this.normalize(x, y);
		const data = new DataView(new ArrayBuffer(7));
		data.setUint8(0, SEND.MouseWheel);
		data.setInt16(1, delta, true);
		data.setUint16(3, coord.x, true);
		data.setUint16(5, coord.y, true);
		this.send(data);
	}

	emitTouchData(type, touches, fingerIds) {
		const { left, top } = this.getBoundingClientRect();
		const data = new DataView(new ArrayBuffer(2 + 6 * touches.length));
		data.setUint8(0, type);
		data.setUint8(1, touches.length);
		let byte = 2;
		for (const touch of touches) {
			const x = touch.clientX - left;
			const y = touch.clientY - top;

			const coord = this.normalize(x, y);
			data.setUint16(byte, coord.x, true);
			byte += 2;
			data.setUint16(byte, coord.y, true);
			byte += 2;
			data.setUint8(byte, fingerIds[touch.identifier], true);
			byte += 1;
			data.setUint8(byte, 255 * touch.force, true); // force is between 0.0 and 1.0 so quantize into byte.
			byte += 1;
		}
		this.send(data);
	}

	// emit string；返回一个 Promise，在 UE 回复下一条 Response 消息时 resolve（企业版 API 兼容）
	emitMessage(msg, messageType = SEND.UIInteraction) {
		if (typeof msg !== "string") msg = JSON.stringify(msg);

		// Add the UTF-16 JSON string to the array byte buffer, going two bytes at a time.
		const data = new DataView(new ArrayBuffer(1 + 2 + 2 * msg.length));
		let byteIdx = 0;
		data.setUint8(byteIdx, messageType);
		byteIdx++;
		data.setUint16(byteIdx, msg.length, true);
		byteIdx += 2;
		for (let i = 0; i < msg.length; i++) {
			// charCodeAt() is UTF-16, codePointAt() is Unicode.
			data.setUint16(byteIdx, msg.charCodeAt(i), true);
			byteIdx += 2;
		}
		if (!this.send(data)) {
			console.error("emitMessage: data channel not open");
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => this.addEventListener("message", (e) => resolve(e.detail), { once: true }));
	}

	normalize(x, y) {
		const normalizedX = x / this.clientWidth;
		const normalizedY = y / this.clientHeight;
		if (normalizedX < 0.0 || normalizedX > 1.0 || normalizedY < 0.0 || normalizedY > 1.0) {
			return {
				inRange: false,
				x: 65535,
				y: 65535,
			};
		} else {
			return {
				inRange: true,
				x: normalizedX * 65536,
				y: normalizedY * 65536,
			};
		}
	}
}

customElements.define("peer-stream", PeerStream, { extends: "video" });
