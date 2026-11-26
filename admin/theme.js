// 主题：在页面绘制前设置（避免闪烁）。ps.theme = auto（跟随系统，默认）/ light / dark
(function () {
	var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
	function pref() {
		try {
			var v = localStorage.getItem("ps.theme");
			return v === "light" || v === "dark" ? v : "auto";
		} catch (e) {
			return "auto";
		}
	}
	function apply() {
		var p = pref();
		var t = p === "auto" ? (mq && mq.matches ? "light" : "dark") : p;
		document.documentElement.setAttribute("data-theme", t);
		document.documentElement.setAttribute("data-theme-pref", p);
	}
	apply();
	if (mq && mq.addEventListener) mq.addEventListener("change", apply);
	window.psTheme = {
		get: pref,
		set: function (v) {
			try {
				localStorage.setItem("ps.theme", v);
			} catch (e) {}
			apply();
		},
	};
})();
