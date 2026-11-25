// ps-platform 渲染节点 Agent 安装程序（Windows 10 / 11）
//
// 一个程序多种用途：
//   （无参数）           图形安装向导：确认平台地址 → 机器名称与 UE 目录 → 安装位置与运行方式 → 安装 → 完成
//   /S                   静默安装（批量部署）：/url= /token= /id= /allow-exe= /dir= /mode=service|logon（默认 service） /noregister
//   /service             Windows 服务宿主（开机自动运行）：守护 Agent 进程，退出后自动重启
//   /run                 登录后运行的宿主（计划任务启动，无窗口）：同上
//   /uninstall [/S]      卸载（「设置 → 应用」中的卸载按钮调用）
//   /extract-agent=文件   释放内置的 Agent 程序（ps-platform.exe）
//   /screenshots=目录     把向导各页截图保存为 PNG（界面检查用）
//
// 安装程序 = 本程序（stub）+ 末尾附加的数据段，从文件末尾向前读取：[数据][8 字节长度][8 字节标记]
//   PSAGENT1  [8 字节原始大小][gzip 压缩的 ps-platform.exe]       （打包时附加）
//   PSCONF01  UTF-8 JSON {url, token, platform, version}         （平台下载时附加：平台地址与接入令牌，离末尾最近的生效）
//
// 只依赖 Windows 自带的 .NET Framework 4.x；用系统自带的 csc.exe（C# 5）编译，见 build/build-exe.js。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("ps-platform 渲染节点 Agent 安装程序")]
[assembly: System.Reflection.AssemblyProduct("ps-platform")]
[assembly: System.Reflection.AssemblyVersion(BuildInfo.NumericVersion)]
[assembly: System.Reflection.AssemblyFileVersion(BuildInfo.NumericVersion)]
[assembly: System.Reflection.AssemblyInformationalVersion(BuildInfo.Version)]

namespace PsAgentSetup
{
	static class Program
	{
		[STAThread]
		static int Main(string[] argv)
		{
			var a = new Args(argv);
			bool silent = a.Has("S") || a.Has("silent");
			try
			{
				if (a.Has("service"))
				{
					ServiceBase.Run(new AgentService(new Host(Util.SelfDir, "service")));
					return 0;
				}
				if (a.Has("run"))
				{
					new Host(a.Get("dir") ?? Util.SelfDir, "logon").RunForeground();
					return 0;
				}
				if (a.Has("extract-agent"))
				{
					Payload.ExtractAgent(Util.SelfPath, a.Get("extract-agent"), null);
					return 0;
				}
				Application.EnableVisualStyles();
				Application.SetCompatibleTextRenderingDefault(false);
				if (a.Has("screenshots")) return Wizard.Screenshots(a.Get("screenshots"));
				if (a.Has("uninstall")) return Uninstaller.Run(a, silent);
				if (silent) return SilentInstall.Run(a);
				Application.Run(new Wizard(SetupState.Load(a)));
				return 0;
			}
			catch (Exception e)
			{
				if (silent) SilentInstall.Report("失败：" + e.Message);
				else MessageBox.Show(e.Message, Util.Product, MessageBoxButtons.OK, MessageBoxIcon.Error);
				return 1;
			}
		}
	}

	/* ------------------------------------------------------------------ 公共 */

	class SetupException : Exception
	{
		public SetupException(string message) : base(message) { }
	}

	static class Util
	{
		public const string Product = "ps-platform 渲染节点 Agent";
		public const string ServiceName = "ps-platform-agent";
		public const string TaskName = "ps-platform-agent";
		public const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ps-platform-agent";
		public const string AgentExe = "ps-platform.exe";
		public const string HostExe = "ps-agent.exe";

		public static string SelfPath { get { return Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location); } }
		public static string SelfDir { get { return Path.GetDirectoryName(SelfPath); } }
		public static string DefaultDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ps-platform-agent"); } }
		public static string Sys(string exe) { return Path.Combine(Environment.SystemDirectory, exe); }

		public static string MB(long bytes) { return (bytes / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB"; }

		public static bool SamePath(string a, string b)
		{
			return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
		}

		public static bool IsInside(string path, string dir)
		{
			if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(dir)) return false;
			return Path.GetFullPath(path).StartsWith(Path.GetFullPath(dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
		}

		/** 按 Windows 命令行规则给参数加引号（\" 转义规则） */
		public static string Q(string s)
		{
			if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
			var sb = new StringBuilder("\"");
			int bs = 0;
			foreach (char c in s)
			{
				if (c == '\\') { bs++; continue; }
				if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
				sb.Append('\\', bs); bs = 0; sb.Append(c);
			}
			sb.Append('\\', bs * 2);
			sb.Append('"');
			return sb.ToString();
		}

		/** 运行系统命令并取回输出（sc / schtasks 的输出使用 OEM 代码页） */
		public static int Exec(string file, string args, out string output)
		{
			var psi = new ProcessStartInfo(file, args);
			psi.UseShellExecute = false;
			psi.CreateNoWindow = true;
			psi.RedirectStandardOutput = true;
			psi.RedirectStandardError = true;
			Encoding enc;
			try { enc = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); } catch { enc = Encoding.Default; }
			psi.StandardOutputEncoding = enc;
			psi.StandardErrorEncoding = enc;
			using (var p = Process.Start(psi))
			{
				var err = p.StandardError.ReadToEndAsync();
				string o = p.StandardOutput.ReadToEnd();
				p.WaitForExit();
				output = (o + err.Result).Trim();
				return p.ExitCode;
			}
		}

		public static string DefaultId()
		{
			string id = Regex.Replace(Environment.MachineName.ToLowerInvariant(), "[^a-z0-9_-]", "-").Trim('-');
			if (id.Length > 64) id = id.Substring(0, 64);
			return id.Length > 0 ? id : "render-01";
		}

		public static bool ValidId(string id) { return Regex.IsMatch(id ?? "", "^[A-Za-z0-9_-]{1,64}$"); }

		public static string CurrentUser() { return WindowsIdentity.GetCurrent().Name; }

		public static string Str(IDictionary d, string k)
		{
			if (d == null || !d.Contains(k) || d[k] == null) return null;
			return Convert.ToString(d[k], CultureInfo.InvariantCulture);
		}

		[DllImport("kernel32.dll", SetLastError = true)]
		static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
		[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
		static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
		[DllImport("kernel32.dll")]
		static extern bool CloseHandle(IntPtr h);

		/** 进程的完整路径（PROCESS_QUERY_LIMITED_INFORMATION，系统服务进程也能取到） */
		public static string ImagePath(int pid)
		{
			IntPtr h = OpenProcess(0x1000, false, pid);
			if (h == IntPtr.Zero) return null;
			try
			{
				var sb = new StringBuilder(1024);
				int n = sb.Capacity;
				return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : null;
			}
			finally { CloseHandle(h); }
		}
	}

	/** 命令行参数：/key=value、/flag、-key=value、--key=value（不区分大小写，可重复） */
	class Args
	{
		readonly Dictionary<string, List<string>> map = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);

		public Args(string[] argv)
		{
			foreach (string raw in argv)
			{
				string s = raw;
				if (s.StartsWith("--")) s = s.Substring(2);
				else if (s.StartsWith("/") || s.StartsWith("-")) s = s.Substring(1);
				else continue;
				string k = s, v = "";
				int i = s.IndexOf('=');
				if (i >= 0) { k = s.Substring(0, i); v = s.Substring(i + 1); }
				List<string> l;
				if (!map.TryGetValue(k, out l)) { l = new List<string>(); map[k] = l; }
				l.Add(v);
			}
		}

		public bool Has(string k) { return map.ContainsKey(k); }
		public string Get(string k) { List<string> l; return map.TryGetValue(k, out l) && l[l.Count - 1] != "" ? l[l.Count - 1] : null; }
		public List<string> All(string k)
		{
			var r = new List<string>();
			List<string> l;
			if (map.TryGetValue(k, out l)) foreach (string v in l) foreach (string p in v.Split(';')) if (p.Trim() != "") r.Add(p.Trim().Trim('"'));
			return r;
		}
	}

	/* ------------------------------------------------------------- 附加数据段 */

	static class Payload
	{
		public const string AgentTag = "PSAGENT1";
		public const string ConfigTag = "PSCONF01";

		public class Section { public string Tag; public long Offset; public long Length; }

		static FileStream Open(string path) { return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }

		static void ReadFull(Stream s, byte[] b, int n)
		{
			int got = 0;
			while (got < n)
			{
				int r = s.Read(b, got, n - got);
				if (r <= 0) throw new EndOfStreamException();
				got += r;
			}
		}

		/** 从末尾向前列出数据段（第一个离末尾最近）；stubLength = 程序本身的长度 */
		public static List<Section> Sections(string path, out long stubLength)
		{
			var list = new List<Section>();
			using (var fs = Open(path))
			{
				long pos = fs.Length;
				var b = new byte[16];
				while (pos >= 16)
				{
					fs.Seek(pos - 16, SeekOrigin.Begin);
					ReadFull(fs, b, 16);
					long len = BitConverter.ToInt64(b, 0);
					string tag = Encoding.ASCII.GetString(b, 8, 8);
					if ((tag != AgentTag && tag != ConfigTag) || len < 0 || len > pos - 16) break;
					pos = pos - 16 - len;
					var s = new Section();
					s.Tag = tag; s.Offset = pos; s.Length = len;
					list.Add(s);
				}
				stubLength = pos;
			}
			return list;
		}

		public static Section Find(List<Section> list, string tag)
		{
			foreach (var s in list) if (s.Tag == tag) return s;
			return null;
		}

		public static bool HasAgent(string path)
		{
			long stub;
			return Find(Sections(path, out stub), AgentTag) != null;
		}

		/** 平台写入的配置（平台地址、接入令牌）；没有则返回 null */
		public static IDictionary ReadConfig(string path)
		{
			long stub;
			var s = Find(Sections(path, out stub), ConfigTag);
			if (s == null || s.Length > 65536) return null;
			using (var fs = Open(path))
			{
				fs.Seek(s.Offset, SeekOrigin.Begin);
				var b = new byte[s.Length];
				ReadFull(fs, b, b.Length);
				try { return new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(b)) as IDictionary; }
				catch { return null; }
			}
		}

		public static void ExtractAgent(string path, string dest, Action<long, long> progress)
		{
			long stub;
			var s = Find(Sections(path, out stub), AgentTag);
			if (s == null) throw new SetupException("安装程序中不包含 Agent 程序（文件不完整），请从管理端「接入渲染机」重新下载安装程序。");
			using (var fs = Open(path))
			{
				fs.Seek(s.Offset, SeekOrigin.Begin);
				var hb = new byte[8];
				ReadFull(fs, hb, 8);
				long total = BitConverter.ToInt64(hb, 0);
				long done = 0;
				using (var sub = new SubStream(fs, s.Length - 8))
				using (var gz = new GZipStream(sub, CompressionMode.Decompress))
				using (var outf = new FileStream(dest, FileMode.Create, FileAccess.Write))
				{
					var buf = new byte[1 << 20];
					int n;
					while ((n = gz.Read(buf, 0, buf.Length)) > 0)
					{
						outf.Write(buf, 0, n);
						done += n;
						if (progress != null) progress(done, total);
					}
				}
				if (done != total) throw new SetupException("Agent 程序解压后大小不符（安装程序可能已损坏），请重新下载。");
			}
		}

		/** 复制程序本身（不含附加数据段），作为安装目录中的管理程序 ps-agent.exe */
		public static void WriteStub(string path, string dest)
		{
			long stub;
			Sections(path, out stub);
			using (var src = Open(path))
			using (var outf = new FileStream(dest, FileMode.Create, FileAccess.Write))
			{
				var buf = new byte[81920];
				long left = stub;
				while (left > 0)
				{
					int n = src.Read(buf, 0, (int)Math.Min(buf.Length, left));
					if (n <= 0) break;
					outf.Write(buf, 0, n);
					left -= n;
				}
			}
		}
	}

	/** 只读的子流：从当前位置起最多读取 length 字节（不关闭底层流） */
	class SubStream : Stream
	{
		readonly Stream inner;
		long left;
		public SubStream(Stream inner, long length) { this.inner = inner; left = length; }
		public override bool CanRead { get { return true; } }
		public override bool CanSeek { get { return false; } }
		public override bool CanWrite { get { return false; } }
		public override long Length { get { throw new NotSupportedException(); } }
		public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
		public override void Flush() { }
		public override int Read(byte[] buffer, int offset, int count)
		{
			if (left <= 0) return 0;
			int n = inner.Read(buffer, offset, (int)Math.Min(count, left));
			left -= n;
			return n;
		}
		public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
		public override void SetLength(long value) { throw new NotSupportedException(); }
		public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
	}

	/* ------------------------------------------------------------- 配置与状态 */

	/** 平台地址：用户可输入 192.168.1.10:88 / http://… / ws://…/agent，统一为 http 源地址与 ws 连接地址 */
	static class Addr
	{
		public static bool Parse(string input, out string http, out string ws)
		{
			http = ws = null;
			string s = (input ?? "").Trim().TrimEnd('/');
			if (s == "") return false;
			bool hadScheme = Regex.IsMatch(s, "^[a-z]+://", RegexOptions.IgnoreCase);
			if (!hadScheme) s = "http://" + s;
			Uri u;
			if (!Uri.TryCreate(s, UriKind.Absolute, out u) || u.Host == "") return false;
			string scheme = u.Scheme.ToLowerInvariant();
			if (scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss") return false;
			bool tls = scheme == "https" || scheme == "wss";
			bool explicitPort = Regex.IsMatch(s, @"^[a-z]+://(\[[^\]]+\]|[^/:]+):\d+", RegexOptions.IgnoreCase);
			string host = u.Host.Contains(":") && !u.Host.StartsWith("[") ? "[" + u.Host + "]" : u.Host;
			// 没写端口时按平台管理口默认端口 88（不是 http 的 80）
			string authority = host + ":" + (explicitPort ? u.Port : 88).ToString(CultureInfo.InvariantCulture);
			http = (tls ? "https://" : "http://") + authority;
			ws = (tls ? "wss://" : "ws://") + authority + "/agent";
			return true;
		}

		public static string HttpFromWs(string ws)
		{
			string h, w;
			return Parse(ws, out h, out w) ? h : null;
		}

		/** 给人看的地址：http:// 省略，https:// 保留 */
		public static string Display(string http)
		{
			if (string.IsNullOrEmpty(http)) return "";
			return http.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? http.Substring(7) : http;
		}
	}

	class AgentConfig
	{
		public string Url = "", Token = "", Id = "";
		public List<string> AllowExe = new List<string>();

		public static AgentConfig Load(string file)
		{
			try
			{
				var d = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as IDictionary;
				if (d == null) return null;
				var c = new AgentConfig();
				c.Url = Util.Str(d, "url") ?? "";
				c.Token = Util.Str(d, "token") ?? "";
				c.Id = Util.Str(d, "id") ?? "";
				var list = d.Contains("allowExe") ? d["allowExe"] as IEnumerable : null;
				if (list != null && !(list is string)) foreach (object o in list) if (o != null && Convert.ToString(o) != "") c.AllowExe.Add(Convert.ToString(o));
				return c;
			}
			catch { return null; }
		}

		public void Save(string file, string stateFile)
		{
			var d = new Dictionary<string, object>();
			d["url"] = Url;
			d["token"] = Token;
			d["id"] = Id;
			d["allowExe"] = AllowExe.ToArray();
			d["state"] = stateFile;
			string tmp = file + ".tmp";
			File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));
			if (File.Exists(file)) File.Delete(file);
			File.Move(tmp, file);
		}
	}

	/** 向导 / 静默安装的初始值：平台下载时写入的配置 > 已安装的配置 > 默认值；命令行参数最优先 */
	class SetupState
	{
		public string Http = "", Ws = "", Token = "", PlatformVersion = "";
		public bool Embedded;
		public string InstalledDir, InstalledMode, InstalledVersion;
		public string Id, Dir, Mode;
		public List<string> AllowExe = new List<string>();

		public static SetupState Load(Args a)
		{
			var s = new SetupState();
			var cfg = Payload.ReadConfig(Util.SelfPath);
			if (cfg != null)
			{
				s.Ws = Util.Str(cfg, "url") ?? "";
				s.Http = Util.Str(cfg, "platform") ?? Addr.HttpFromWs(s.Ws) ?? "";
				s.Token = Util.Str(cfg, "token") ?? "";
				s.PlatformVersion = Util.Str(cfg, "version") ?? "";
				s.Embedded = s.Ws != "" && s.Token != "";
			}
			AgentConfig installed = null;
			try
			{
				using (var k = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(Util.UninstallKey))
				{
					if (k != null)
					{
						s.InstalledDir = k.GetValue("InstallLocation") as string;
						s.InstalledMode = k.GetValue("AgentMode") as string;
						s.InstalledVersion = k.GetValue("DisplayVersion") as string;
					}
				}
			}
			catch { }
			// 直接运行安装目录中的 ps-agent.exe（修改设置）时，即使没有注册表项也能识别
			if (s.InstalledDir == null && File.Exists(Path.Combine(Util.SelfDir, "data", "agent.json"))) s.InstalledDir = Util.SelfDir;
			if (s.InstalledDir != null) installed = AgentConfig.Load(Path.Combine(s.InstalledDir, "data", "agent.json"));
			if (installed != null && !s.Embedded)
			{
				s.Ws = installed.Url;
				s.Http = Addr.HttpFromWs(installed.Url) ?? "";
				s.Token = installed.Token;
			}
			s.Id = installed != null && installed.Id != "" ? installed.Id : Util.DefaultId();
			if (installed != null) s.AllowExe.AddRange(installed.AllowExe);
			s.Dir = s.InstalledDir ?? Util.DefaultDir;
			s.Mode = s.InstalledMode ?? "service";

			string url = a.Get("url");
			if (url != null)
			{
				string h, w;
				if (!Addr.Parse(url, out h, out w)) throw new SetupException("平台地址格式不正确：" + url);
				s.Http = h; s.Ws = w;
			}
			if (a.Get("token") != null) s.Token = a.Get("token");
			if (a.Get("id") != null) s.Id = a.Get("id");
			if (a.Has("allow-exe")) s.AllowExe = a.All("allow-exe");
			if (a.Get("dir") != null) s.Dir = a.Get("dir");
			if (a.Get("mode") != null) s.Mode = a.Get("mode").ToLowerInvariant() == "service" ? "service" : "logon";
			return s;
		}
	}

	/* ------------------------------------------------------------------ 连接检测 */

	static class Probe
	{
		/** 检查平台是否可达、接入令牌是否正确（平台 /agent/check）。ok=false 时返回原因 */
		public static string Check(string http, string token, out bool ok)
		{
			ok = false;
			try
			{
				ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
				var req = (HttpWebRequest)WebRequest.Create(http + "/agent/check");
				req.Timeout = 6000;
				req.ReadWriteTimeout = 6000;
				req.Proxy = null; // 平台在内网，不走系统代理
				req.Headers["X-Agent-Token"] = token ?? "";
				using (var resp = (HttpWebResponse)req.GetResponse())
				using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
				{
					var d = new JavaScriptSerializer().DeserializeObject(r.ReadToEnd()) as IDictionary;
					string v = Util.Str(d, "version");
					ok = true;
					return "已连接平台" + (string.IsNullOrEmpty(v) ? "" : "（版本 " + v + "）") + "，接入令牌正确";
				}
			}
			catch (WebException e)
			{
				var r = e.Response as HttpWebResponse;
				if (r != null)
				{
					int code = (int)r.StatusCode;
					if (code == 401) return "接入令牌不正确：请在管理端「接入渲染机」中重新下载安装程序，或复制最新令牌";
					if (code == 403) return "平台拒绝了本机：本机 IP 不在平台允许的网段（管理端「系统设置 → 安全 → UE/Agent 允许网段」）";
					if (code == 404) { ok = true; return "已连接平台（平台版本较旧，无法校验令牌）"; }
					return "平台返回 HTTP " + code;
				}
				if (e.Status == WebExceptionStatus.Timeout) return "连接平台超时：请确认地址正确、本机与平台网络互通，且防火墙放行平台管理口";
				if (e.Status == WebExceptionStatus.TrustFailure || e.Status == WebExceptionStatus.SecureChannelFailure) return "平台的 HTTPS 证书不受信任";
				return "无法连接平台：" + e.Message;
			}
			catch (Exception e)
			{
				return "无法连接平台：" + e.Message;
			}
		}
	}

	/* ------------------------------------------------------------------ 安装 */

	class InstallOptions
	{
		public string Http, Ws, Token, Id, Dir, Mode = "service";
		public List<string> AllowExe = new List<string>();
		public bool NoRegister;
	}

	class InstallResult
	{
		public bool Connected;
		public string Reason = "";
		public string LogDir = "";
	}

	/** 系统操作：服务、计划任务、进程、注册表、目录权限 */
	static class Ops
	{
		public static bool ServiceExists()
		{
			foreach (var s in ServiceController.GetServices()) if (string.Equals(s.ServiceName, Util.ServiceName, StringComparison.OrdinalIgnoreCase)) return true;
			return false;
		}

		public static void StopService(Action<string> log)
		{
			if (!ServiceExists()) return;
			using (var sc = new ServiceController(Util.ServiceName))
			{
				if (sc.Status == ServiceControllerStatus.Stopped) return;
				log("停止 Windows 服务 " + Util.ServiceName);
				try
				{
					if (sc.Status != ServiceControllerStatus.StopPending) sc.Stop();
					sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
				}
				catch (Exception e) { log("停止服务失败（继续）：" + e.Message); }
			}
		}

		public static void EndTask()
		{
			string o;
			Util.Exec(Util.Sys("schtasks.exe"), "/End /TN " + Util.TaskName, out o);
		}

		/** 结束安装目录中的宿主与 Agent 进程（不结束 UE：重新启动的 Agent 会接管仍在运行的 UE） */
		public static void KillProcessesIn(string dir, Action<string> log)
		{
			int self = Process.GetCurrentProcess().Id;
			foreach (var p in Process.GetProcesses())
			{
				try
				{
					string n = p.ProcessName.ToLowerInvariant();
					if (p.Id == self || (n != "ps-agent" && n != "ps-platform")) continue;
					string path = Util.ImagePath(p.Id);
					if (path == null || !Util.IsInside(path, dir)) continue;
					log("结束进程 " + Path.GetFileName(path) + "（PID " + p.Id + "）");
					p.Kill();
					p.WaitForExit(5000);
				}
				catch { }
				finally { p.Dispose(); }
			}
		}

		public static void StopAll(string dir, Action<string> log)
		{
			StopService(log);
			EndTask();
			KillProcessesIn(dir, log);
		}

		/** 替换文件：旧进程刚结束时文件可能仍被占用，重试几次 */
		public static void ReplaceFile(string tmp, string dest)
		{
			for (int i = 0; ; i++)
			{
				try
				{
					if (File.Exists(dest)) File.Delete(dest);
					File.Move(tmp, dest);
					return;
				}
				catch (Exception e)
				{
					if (i >= 20) throw new SetupException("无法替换 " + dest + "：" + e.Message + "（文件被占用，请关闭相关程序后重试）");
					Thread.Sleep(500);
				}
			}
		}

		/** data 目录只允许 SYSTEM、管理员（以及登录模式下运行 Agent 的用户）访问：其中的 agent.json 含接入令牌 */
		public static void SecureDir(string dir, string user)
		{
			var ds = new DirectorySecurity();
			ds.SetAccessRuleProtection(true, false);
			var inh = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
			ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inh, PropagationFlags.None, AccessControlType.Allow));
			ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inh, PropagationFlags.None, AccessControlType.Allow));
			if (!string.IsNullOrEmpty(user))
			{
				try { ds.AddAccessRule(new FileSystemAccessRule(new NTAccount(user), FileSystemRights.FullControl, inh, PropagationFlags.None, AccessControlType.Allow)); } catch { }
			}
			Directory.SetAccessControl(dir, ds);
		}

		static void Run(string file, string args, string what)
		{
			string o;
			int code = Util.Exec(file, args, out o);
			if (code != 0) throw new SetupException(what + "失败（" + code + "）：" + o);
		}

		public static void InstallService(string host, Action<string> log)
		{
			string bin = Util.Q(host) + " /service";
			string verb = ServiceExists() ? "config " : "create ";
			log((verb == "create " ? "创建" : "更新") + " Windows 服务 " + Util.ServiceName + "（开机自动运行）");
			Run(Util.Sys("sc.exe"), verb + Util.ServiceName + " binPath= " + Util.Q(bin) + " start= auto DisplayName= " + Util.Q(Util.Product), "注册 Windows 服务");
			string o;
			Util.Exec(Util.Sys("sc.exe"), "description " + Util.ServiceName + " " + Util.Q("ps-platform 渲染节点：上报显卡与运行状态，按平台调度启动 UE 程序"), out o);
			Util.Exec(Util.Sys("sc.exe"), "failure " + Util.ServiceName + " reset= 86400 actions= restart/5000/restart/10000/restart/30000", out o);
		}

		public static void StartService(Action<string> log)
		{
			using (var sc = new ServiceController(Util.ServiceName))
			{
				if (sc.Status == ServiceControllerStatus.Running) return;
				log("启动 Windows 服务");
				sc.Start();
				sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
			}
		}

		public static void RemoveService(Action<string> log)
		{
			if (!ServiceExists()) return;
			StopService(log);
			log("删除 Windows 服务 " + Util.ServiceName);
			string o;
			Util.Exec(Util.Sys("sc.exe"), "delete " + Util.ServiceName, out o);
		}

		static string X(string s) { return System.Security.SecurityElement.Escape(s); }

		/** 登录后运行：当前用户登录时以最高权限启动宿主（不限运行时长、使用电池也运行、正常优先级） */
		public static void InstallTask(string host, string user, Action<string> log)
		{
			log("创建计划任务 " + Util.TaskName + "（" + user + " 登录 Windows 后自动运行）");
			string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" +
				"<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n" +
				"  <RegistrationInfo><Description>ps-platform 渲染节点 Agent：登录 Windows 后自动运行</Description></RegistrationInfo>\r\n" +
				"  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + X(user) + "</UserId></LogonTrigger></Triggers>\r\n" +
				"  <Principals><Principal id=\"Author\"><UserId>" + X(user) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>\r\n" +
				"  <Settings>\r\n" +
				"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n" +
				"    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n" +
				"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n" +
				"    <AllowHardTerminate>true</AllowHardTerminate>\r\n" +
				"    <StartWhenAvailable>true</StartWhenAvailable>\r\n" +
				"    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r\n" +
				"    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>\r\n" +
				"    <AllowStartOnDemand>true</AllowStartOnDemand>\r\n" +
				"    <Enabled>true</Enabled>\r\n" +
				"    <Hidden>false</Hidden>\r\n" +
				"    <RunOnlyIfIdle>false</RunOnlyIfIdle>\r\n" +
				"    <WakeToRun>false</WakeToRun>\r\n" +
				"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\r\n" +
				"    <Priority>4</Priority>\r\n" +
				"    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>\r\n" +
				"  </Settings>\r\n" +
				"  <Actions Context=\"Author\"><Exec><Command>" + X(host) + "</Command><Arguments>/run</Arguments><WorkingDirectory>" + X(Path.GetDirectoryName(host)) + "</WorkingDirectory></Exec></Actions>\r\n" +
				"</Task>\r\n";
			string file = Path.Combine(Path.GetTempPath(), "ps-platform-agent-task-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".xml");
			File.WriteAllText(file, xml, Encoding.Unicode);
			try { Run(Util.Sys("schtasks.exe"), "/Create /TN " + Util.TaskName + " /XML " + Util.Q(file) + " /F", "创建计划任务"); }
			finally { try { File.Delete(file); } catch { } }
		}

		/** 安装目录中的宿主是否在运行（不含当前进程） */
		public static bool HostRunning(string host)
		{
			int self = Process.GetCurrentProcess().Id;
			foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Util.HostExe)))
			{
				try { if (p.Id != self && Util.SamePath(Util.ImagePath(p.Id) ?? "", host)) return true; }
				catch { }
				finally { p.Dispose(); }
			}
			return false;
		}

		/**
		 * 立即启动 Agent：先按计划任务启动；个别环境（例如远程桌面登录的 Windows Server）计划任务会拒绝按需启动
		 * （schtasks 仍返回成功，任务结果 0x800710E0），此时直接在当前会话启动宿主。之后每次登录仍由计划任务启动。
		 */
		public static void RunTask(string host, Action<string> log)
		{
			log("启动 Agent（计划任务）");
			string o;
			Util.Exec(Util.Sys("schtasks.exe"), "/Run /TN " + Util.TaskName, out o);
			for (int i = 0; i < 8; i++)
			{
				Thread.Sleep(500);
				if (HostRunning(host)) return;
			}
			log("计划任务未能立即启动，改为在当前会话中直接启动 Agent（以后登录 Windows 时仍由计划任务自动启动）");
			// 优先经 WMI 启动：宿主不成为安装程序的子进程，批量部署脚本中的 Start-Process -Wait 不会因等待它而卡住
			if (StartDetached(Util.Q(host) + " /run", Path.GetDirectoryName(host))) return;
			var psi = new ProcessStartInfo(host, "/run");
			psi.UseShellExecute = false;
			psi.WorkingDirectory = Path.GetDirectoryName(host);
			Process.Start(psi);
		}

		/** 经 WMI（Win32_Process.Create）在当前会话启动进程，进程不属于调用者的进程树 / 作业对象 */
		static bool StartDetached(string commandLine, string dir)
		{
			try
			{
				using (var cls = new System.Management.ManagementClass("Win32_Process"))
				{
					var inParams = cls.GetMethodParameters("Create");
					inParams["CommandLine"] = commandLine;
					inParams["CurrentDirectory"] = dir;
					var outParams = cls.InvokeMethod("Create", inParams, null);
					return Convert.ToInt32(outParams["ReturnValue"], CultureInfo.InvariantCulture) == 0;
				}
			}
			catch { return false; }
		}

		public static void RemoveTask(Action<string> log)
		{
			string o;
			if (Util.Exec(Util.Sys("schtasks.exe"), "/Query /TN " + Util.TaskName, out o) != 0) return;
			log("删除计划任务 " + Util.TaskName);
			EndTask();
			Util.Exec(Util.Sys("schtasks.exe"), "/Delete /TN " + Util.TaskName + " /F", out o);
		}

		static RegistryKey Hklm() { return RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64); }

		/** 「设置 → 应用」中的条目：可卸载，「修改」重新打开向导调整设置 */
		public static void WriteUninstallEntry(string dir, string mode, long sizeBytes)
		{
			string host = Path.Combine(dir, Util.HostExe);
			using (var k = Hklm().CreateSubKey(Util.UninstallKey))
			{
				k.SetValue("DisplayName", Util.Product);
				k.SetValue("DisplayVersion", BuildInfo.Version);
				k.SetValue("Publisher", "ps-platform");
				k.SetValue("InstallLocation", dir);
				k.SetValue("DisplayIcon", host);
				k.SetValue("UninstallString", Util.Q(host) + " /uninstall");
				k.SetValue("QuietUninstallString", Util.Q(host) + " /uninstall /S");
				k.SetValue("ModifyPath", Util.Q(host));
				k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
				k.SetValue("EstimatedSize", (int)(sizeBytes / 1024), RegistryValueKind.DWord);
				k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture));
				k.SetValue("AgentMode", mode);
			}
		}

		public static void RemoveUninstallEntry()
		{
			try { Hklm().DeleteSubKeyTree(Util.UninstallKey, false); } catch { }
		}
	}

	class Installer
	{
		public Action<string> Log = delegate { };
		public Action<string> Step = delegate { };
		public Action<int> Progress = delegate { };

		/** 安装目录检查：不允许装到磁盘根目录或已有其它文件的目录（卸载时只删除自己的文件，但仍应避免混放） */
		public static string CheckDir(string dir)
		{
			string full;
			try { full = Path.GetFullPath(dir); } catch { return "安装位置不是有效的路径"; }
			if (!Path.IsPathRooted(dir)) return "安装位置必须是完整路径，例如 C:\\Program Files\\ps-platform-agent";
			if (Path.GetPathRoot(full).TrimEnd('\\').Equals(full.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return "不能直接安装到磁盘根目录，请选择一个文件夹";
			if (Directory.Exists(full))
			{
				bool ours = File.Exists(Path.Combine(full, Util.HostExe)) || File.Exists(Path.Combine(full, Util.AgentExe));
				if (!ours && Directory.GetFileSystemEntries(full).Length > 0) return "该文件夹中已有其它文件，请选择空文件夹或新文件夹";
			}
			return null;
		}

		public InstallResult Run(InstallOptions o)
		{
			string dir = Path.GetFullPath(o.Dir);
			string bad = CheckDir(dir);
			if (bad != null) throw new SetupException(bad);
			if (!Util.ValidId(o.Id)) throw new SetupException("机器名称只能包含字母、数字、- 和 _（1-64 个字符）");
			if (string.IsNullOrEmpty(o.Ws)) throw new SetupException("缺少平台地址");
			string data = Path.Combine(dir, "data");
			string agentExe = Path.Combine(dir, Util.AgentExe);
			string host = Path.Combine(dir, Util.HostExe);
			string self = Util.SelfPath;
			bool hasAgent = Payload.HasAgent(self);
			if (!hasAgent && !File.Exists(agentExe)) throw new SetupException("安装程序不完整：不包含 Agent 程序。请从管理端「接入渲染机」重新下载安装程序。");

			Step("停止正在运行的 Agent");
			Progress(3);
			Ops.StopAll(dir, Log);
			Directory.CreateDirectory(dir);

			if (hasAgent)
			{
				Step("释放 Agent 程序");
				string tmp = agentExe + ".new";
				Payload.ExtractAgent(self, tmp, (d, t) => Progress(8 + (int)(62 * d / Math.Max(1L, t))));
				Ops.ReplaceFile(tmp, agentExe);
				Log("Agent 程序：" + agentExe + "（" + Util.MB(new FileInfo(agentExe).Length) + "）");
			}
			if (!Util.SamePath(self, host))
			{
				Payload.WriteStub(self, host + ".new");
				Ops.ReplaceFile(host + ".new", host);
			}
			Progress(72);

			Step("写入配置");
			Directory.CreateDirectory(data);
			Directory.CreateDirectory(Path.Combine(data, "logs"));
			Ops.SecureDir(data, o.Mode == "logon" ? Util.CurrentUser() : null);
			var cfg = new AgentConfig();
			cfg.Url = o.Ws; cfg.Token = o.Token ?? ""; cfg.Id = o.Id; cfg.AllowExe = o.AllowExe;
			cfg.Save(Path.Combine(data, "agent.json"), Path.Combine(data, "agent-state.json"));
			Log("机器名称：" + o.Id + "　平台：" + o.Ws);
			Log("允许启动的程序目录：" + (o.AllowExe.Count > 0 ? string.Join("；", o.AllowExe.ToArray()) : "不限制"));
			Progress(78);

			var r = new InstallResult();
			r.LogDir = Path.Combine(data, "logs");
			if (o.NoRegister)
			{
				Progress(100);
				r.Reason = "未注册自动运行（/noregister）";
				return r;
			}
			Step(o.Mode == "service" ? "注册 Windows 服务（开机自动运行）" : "设置登录 Windows 后自动运行");
			if (o.Mode == "service")
			{
				Ops.RemoveTask(Log);
				Ops.InstallService(host, Log);
			}
			else
			{
				Ops.RemoveService(Log);
				Ops.InstallTask(host, Util.CurrentUser(), Log);
			}
			Progress(84);
			Step("添加到 Windows「应用」列表");
			long size = new FileInfo(agentExe).Length + new FileInfo(host).Length;
			Ops.WriteUninstallEntry(dir, o.Mode, size);
			Progress(88);

			Step("启动 Agent");
			long mark = Host.LogLength(data);
			if (o.Mode == "service") Ops.StartService(Log);
			else Ops.RunTask(host, Log);
			Progress(90);

			Step("等待连接平台");
			WaitConnected(data, mark, 25, r);
			Progress(100);
			Log(r.Connected ? "已连接平台" : "暂未连上平台：" + r.Reason);
			return r;
		}

		/** 读取宿主写入的日志，判断 Agent 是否已连上平台；连接失败时给出可读原因 */
		static void WaitConnected(string data, long mark, int seconds, InstallResult r)
		{
			string reason = "";
			DateTime end = DateTime.Now.AddSeconds(seconds);
			while (DateTime.Now < end)
			{
				Thread.Sleep(500);
				string text = Host.ReadLogSince(data, mark);
				if (text.Contains("[agent] connected")) { r.Connected = true; return; }
				if (text.Contains("Unexpected server response: 401")) reason = "接入令牌不正确";
				else if (text.Contains("Unexpected server response: 403")) reason = "本机 IP 不在平台允许的网段（系统设置 → 安全 → UE/Agent 允许网段）";
				else if (text.Contains("ECONNREFUSED")) reason = "平台拒绝连接（ECONNREFUSED）：请确认平台地址与端口";
				else if (text.Contains("ETIMEDOUT") || text.Contains("EHOSTUNREACH") || text.Contains("ENETUNREACH")) reason = "网络不通：本机无法访问平台地址";
				else if (text.Contains("ENOTFOUND")) reason = "平台地址无法解析";
				else if (text.Contains("找不到 Agent 程序")) reason = "找不到 Agent 程序";
			}
			r.Reason = reason != "" ? reason : seconds + " 秒内未连上平台";
		}
	}

	static class SilentInstall
	{
		static readonly string LogFile = Path.Combine(Path.GetTempPath(), "ps-platform-agent-setup.log");

		[DllImport("kernel32.dll")]
		static extern bool AttachConsole(int pid);

		public static void Report(string line)
		{
			string s = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + line;
			try { File.AppendAllText(LogFile, s + Environment.NewLine, Encoding.UTF8); } catch { }
			try { Console.WriteLine(line); } catch { }
		}

		public static int Run(Args a)
		{
			AttachConsole(-1); // 从命令行运行时把结果输出到该命令行窗口
			Report("ps-platform 渲染节点 Agent 静默安装 " + BuildInfo.Version);
			var st = SetupState.Load(a);
			if (string.IsNullOrEmpty(st.Ws) || string.IsNullOrEmpty(st.Token))
				throw new SetupException("缺少平台地址或接入令牌：请使用管理端「接入渲染机」下载的安装程序，或指定 /url= 与 /token=");
			var o = new InstallOptions();
			o.Http = st.Http; o.Ws = st.Ws; o.Token = st.Token; o.Id = st.Id; o.Dir = st.Dir; o.Mode = st.Mode; o.AllowExe = st.AllowExe;
			o.NoRegister = a.Has("noregister");
			var ins = new Installer();
			ins.Log = m => Report("  " + m);
			ins.Step = m => Report(m);
			var r = ins.Run(o);
			Report(r.Connected ? "安装完成：本机已作为 " + o.Id + " 接入平台" : "安装完成，但暂未连上平台：" + r.Reason + "（日志：" + r.LogDir + "）");
			return 0;
		}
	}

	/* ------------------------------------------------------------------ 卸载 */

	static class Uninstaller
	{
		public static int Run(Args a, bool silent)
		{
			string dir = a.Get("dir");
			if (dir == null)
			{
				var st = SetupState.Load(new Args(new string[0]));
				dir = st.InstalledDir ?? Util.SelfDir;
			}
			if (!a.Has("stage2"))
			{
				if (!silent && MessageBox.Show("确定卸载 " + Util.Product + "？\n\n将停止 Agent、取消自动运行，并删除程序与配置（" + dir + "）。\n由 Agent 启动且仍在运行的 UE 程序也会被结束。", Util.Product, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 1;
				// 程序在安装目录中运行时无法删除自己：复制到临时目录再执行
				if (Util.IsInside(Util.SelfPath, dir))
				{
					string tmp = Path.Combine(Path.GetTempPath(), "ps-agent-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
					Payload.WriteStub(Util.SelfPath, tmp);
					var psi = new ProcessStartInfo(tmp, "/uninstall /stage2 /dir=" + Util.Q(dir) + " /parent=" + Process.GetCurrentProcess().Id + (silent ? " /S" : ""));
					psi.UseShellExecute = false;
					Process.Start(psi);
					return 0;
				}
			}
			else
			{
				int parent;
				if (int.TryParse(a.Get("parent") ?? "", out parent))
				{
					try { Process.GetProcessById(parent).WaitForExit(10000); } catch { }
				}
			}
			var log = new StringBuilder();
			string left = Remove(dir, m => log.AppendLine(m));
			if (!silent)
			{
				if (left == null) MessageBox.Show(Util.Product + " 已卸载。", Util.Product, MessageBoxButtons.OK, MessageBoxIcon.Information);
				else MessageBox.Show("已卸载，但以下文件未能删除，可稍后手动删除：\n" + left, Util.Product, MessageBoxButtons.OK, MessageBoxIcon.Warning);
			}
			if (a.Has("stage2"))
			{
				var psi = new ProcessStartInfo(Util.Sys("cmd.exe"), "/c ping 127.0.0.1 -n 3 > nul & del /f /q " + Util.Q(Util.SelfPath));
				psi.UseShellExecute = false;
				psi.CreateNoWindow = true;
				try { Process.Start(psi); } catch { }
			}
			return 0;
		}

		/** 卸载：只删除本程序创建的文件（ps-agent.exe、ps-platform.exe、data），目录为空时再删除目录。返回未能删除的内容 */
		static string Remove(string dir, Action<string> log)
		{
			Ops.RemoveService(log);
			Ops.RemoveTask(log);
			Ops.KillProcessesIn(dir, log);
			KillUe(Path.Combine(dir, "data", "agent-state.json"), log);
			Ops.RemoveUninstallEntry();
			var failed = new List<string>();
			foreach (string f in new[] { Util.HostExe, Util.AgentExe, Util.AgentExe + ".new", Util.HostExe + ".new" })
			{
				string p = Path.Combine(dir, f);
				if (!File.Exists(p)) continue;
				if (!Retry(() => File.Delete(p))) failed.Add(p);
			}
			string data = Path.Combine(dir, "data");
			if (Directory.Exists(data) && !Retry(() => Directory.Delete(data, true))) failed.Add(data);
			try { if (Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length == 0) Directory.Delete(dir); } catch { }
			return failed.Count > 0 ? string.Join("\n", failed.ToArray()) : null;
		}

		static bool Retry(Action fn)
		{
			for (int i = 0; i < 10; i++)
			{
				try { fn(); return true; } catch { Thread.Sleep(500); }
			}
			return false;
		}

		/** 结束 Agent 进程表中记录的 UE（核对可执行文件路径，避免误杀复用了 PID 的其它进程） */
		static void KillUe(string stateFile, Action<string> log)
		{
			try
			{
				if (!File.Exists(stateFile)) return;
				var list = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(stateFile, Encoding.UTF8)) as IEnumerable;
				if (list == null) return;
				foreach (object o in list)
				{
					var d = o as IDictionary;
					int pid;
					if (d == null || !int.TryParse(Util.Str(d, "pid") ?? "", out pid)) continue;
					string exe = Util.Str(d, "exe");
					string path = Util.ImagePath(pid);
					if (path == null || exe == null || !Util.SamePath(path, exe)) continue;
					log("结束 UE 进程 " + Path.GetFileName(path) + "（PID " + pid + "）");
					string outp;
					Util.Exec(Util.Sys("taskkill.exe"), "/PID " + pid + " /T /F", out outp);
				}
			}
			catch { }
		}
	}

	/* ------------------------------------------------------------- 运行宿主 */

	/** 守护 Agent 进程：退出后按退避时间重启；输出写入 data\logs\agent-日期.log（保留 14 天） */
	class Host
	{
		readonly string dir, data, agentExe, config, logDir, mode;
		volatile bool stopping;
		Process child;
		Thread thread;
		static readonly object logLock = new object();

		public Host(string dir, string mode)
		{
			this.dir = dir;
			this.mode = mode;
			data = Path.Combine(dir, "data");
			agentExe = Path.Combine(dir, Util.AgentExe);
			config = Path.Combine(data, "agent.json");
			logDir = Path.Combine(data, "logs");
		}

		public static string LogFile(string data) { return Path.Combine(data, "logs", "agent-" + DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture) + ".log"); }

		public static long LogLength(string data)
		{
			try { var f = new FileInfo(LogFile(data)); return f.Exists ? f.Length : 0; } catch { return 0; }
		}

		public static string ReadLogSince(string data, long mark)
		{
			try
			{
				using (var fs = new FileStream(LogFile(data), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
				{
					if (mark > fs.Length) mark = 0;
					fs.Seek(mark, SeekOrigin.Begin);
					using (var r = new StreamReader(fs, Encoding.UTF8)) return r.ReadToEnd();
				}
			}
			catch { return ""; }
		}

		void Log(string line)
		{
			lock (logLock)
			{
				try
				{
					Directory.CreateDirectory(logDir);
					File.AppendAllText(LogFile(data), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine, Encoding.UTF8);
				}
				catch { }
			}
		}

		public void Start()
		{
			thread = new Thread(Loop);
			thread.IsBackground = true;
			thread.Start();
		}

		public void RunForeground() { Loop(); }

		public void Stop()
		{
			stopping = true;
			KillChild();
			if (thread != null) thread.Join(8000);
		}

		void KillChild()
		{
			try { var c = child; if (c != null && !c.HasExited) c.Kill(); } catch { }
		}

		void Loop()
		{
			Mutex mutex = null;
			try
			{
				// 同一台机器只运行一个宿主（服务与登录任务不会同时守护两个 Agent）
				bool created;
				try { mutex = new Mutex(false, @"Global\ps-platform-agent-host", out created); } catch { mutex = null; }
				bool owned = false;
				while (!stopping && mutex != null && !owned)
				{
					try { owned = mutex.WaitOne(1000); } catch (AbandonedMutexException) { owned = true; }
				}
				CleanupLogs();
				Log("[host] 启动（" + (mode == "service" ? "Windows 服务" : "登录后运行") + "，版本 " + BuildInfo.Version + "）");
				Ops.KillProcessesIn(dir, m => Log("[host] " + m));
				int fails = 0;
				while (!stopping)
				{
					DateTime t0 = DateTime.UtcNow;
					try { RunOnce(); }
					catch (Exception e) { Log("[host] 启动 Agent 失败：" + e.Message); }
					if (stopping) break;
					fails = (DateTime.UtcNow - t0).TotalSeconds > 60 ? 0 : fails + 1;
					int delay = Math.Min(30, 1 << Math.Min(fails, 5));
					Log("[host] " + delay + " 秒后重新启动 Agent");
					for (int i = 0; i < delay * 10 && !stopping; i++) Thread.Sleep(100);
				}
				Log("[host] 已停止");
			}
			finally
			{
				if (mutex != null) { try { mutex.ReleaseMutex(); } catch { } mutex.Dispose(); }
			}
		}

		void RunOnce()
		{
			if (!File.Exists(agentExe)) throw new FileNotFoundException("找不到 Agent 程序 " + agentExe);
			var psi = new ProcessStartInfo(agentExe, "--agent --config " + Util.Q(config));
			psi.UseShellExecute = false;
			psi.CreateNoWindow = true;
			psi.RedirectStandardOutput = true;
			psi.RedirectStandardError = true;
			psi.StandardOutputEncoding = Encoding.UTF8;
			psi.StandardErrorEncoding = Encoding.UTF8;
			psi.WorkingDirectory = dir;
			var p = new Process();
			p.StartInfo = psi;
			p.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
			p.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
			p.Start();
			child = p;
			p.BeginOutputReadLine();
			p.BeginErrorReadLine();
			// 只等进程退出（不等输出流结束）：UE 不继承 Agent 的输出管道，但保持稳妥
			while (!p.WaitForExit(1000)) { if (stopping) return; }
			Log("[host] Agent 已退出（代码 " + p.ExitCode + "）");
		}

		void CleanupLogs()
		{
			try
			{
				if (!Directory.Exists(logDir)) return;
				foreach (string f in Directory.GetFiles(logDir, "agent-*.log"))
					if (File.GetLastWriteTime(f) < DateTime.Now.AddDays(-14)) File.Delete(f);
			}
			catch { }
		}
	}

	class AgentService : ServiceBase
	{
		readonly Host host;
		public AgentService(Host host)
		{
			this.host = host;
			ServiceName = Util.ServiceName;
			CanStop = true;
			CanShutdown = true;
			AutoLog = false;
		}
		protected override void OnStart(string[] args) { host.Start(); }
		protected override void OnStop() { host.Stop(); }
		protected override void OnShutdown() { host.Stop(); }
	}

	/* ------------------------------------------------------------------ 向导 */

	class Wizard : Form
	{
		readonly SetupState st;
		Label lblTitle, lblSub, lblStep;
		Button btnBack, btnNext, btnCancel;
		readonly List<Panel> pages = new List<Panel>();
		int page;

		// 第 1 页：连接平台
		TextBox txtAddr, txtToken;
		CheckBox chkShow;
		Button btnCheck;
		Label lblCheck;
		string checkedKey;
		bool checkOk, checking;
		// 第 2 页：本机设置
		TextBox txtId;
		ListBox lstDirs;
		// 第 3 页：安装选项
		TextBox txtDir;
		RadioButton rbLogon, rbService;
		// 第 4 页：安装中
		Label lblNow;
		ProgressBar bar;
		TextBox txtLog;
		// 第 5 页：完成
		Label lblDone, lblDoneText;
		LinkLabel lnkLogs, lnkAdmin;
		bool installing, finished, failed;
		InstallResult result;
		string resultLogDir;

		static readonly Color Accent = Color.FromArgb(37, 99, 235);
		static readonly Color Muted = Color.FromArgb(100, 110, 125);
		static readonly Color OkColor = Color.FromArgb(22, 128, 61);
		static readonly Color BadColor = Color.FromArgb(200, 40, 40);

		// 按屏幕 DPI 换算坐标（字体以磅为单位，系统会自动放大）。不用 WinForms 自动缩放：代码创建的控件在高 DPI 下尺寸会被放大两次
		static readonly float K = ScreenScale();
		static float ScreenScale()
		{
			try { using (var g = Graphics.FromHwnd(IntPtr.Zero)) return Math.Max(1f, g.DpiX / 96f); } catch { return 1f; }
		}
		static int S(int v) { return (int)Math.Round(v * K); }
		static Point P(int x, int y) { return new Point(S(x), S(y)); }
		static Size Z(int w, int h) { return new Size(S(w), S(h)); }

		public Wizard(SetupState st)
		{
			this.st = st;
			SuspendLayout();
			AutoScaleMode = AutoScaleMode.None;
			Font = new Font("Microsoft YaHei UI", 9F);
			Text = Util.Product + " 安装向导";
			ClientSize = Z(660, 470);
			FormBorderStyle = FormBorderStyle.FixedDialog;
			MaximizeBox = false;
			MinimizeBox = true;
			StartPosition = FormStartPosition.CenterScreen;
			BackColor = Color.White;
			try { Icon = Icon.ExtractAssociatedIcon(Util.SelfPath); } catch { }

			var header = new Panel { Location = P(0, 0), Size = Z(660, 70), BackColor = Color.FromArgb(246, 248, 252) };
			lblTitle = new Label { Location = P(24, 14), Size = Z(520, 26), Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold), ForeColor = Color.FromArgb(20, 30, 50) };
			lblSub = new Label { Location = P(25, 42), Size = Z(520, 20), ForeColor = Muted };
			lblStep = new Label { Location = P(540, 26), Size = Z(100, 20), TextAlign = ContentAlignment.MiddleRight, ForeColor = Muted };
			header.Controls.AddRange(new Control[] { lblTitle, lblSub, lblStep });
			var line1 = new Label { Location = P(0, 70), Size = Z(660, 1), BackColor = Color.FromArgb(225, 229, 236) };
			var line2 = new Label { Location = P(0, 418), Size = Z(660, 1), BackColor = Color.FromArgb(225, 229, 236) };
			btnBack = new Button { Text = "< 上一步", Location = P(352, 430), Size = Z(90, 28) };
			btnNext = new Button { Text = "下一步 >", Location = P(448, 430), Size = Z(90, 28) };
			btnCancel = new Button { Text = "取消", Location = P(552, 430), Size = Z(90, 28) };
			btnBack.Click += (s, e) => Go(page == 4 ? 2 : page - 1); // 安装失败时从完成页返回安装选项
			btnNext.Click += (s, e) => Next();
			btnCancel.Click += (s, e) => Close();
			AcceptButton = btnNext;
			Controls.AddRange(new Control[] { header, line1, line2, btnBack, btnNext, btnCancel });

			pages.Add(BuildConnect());
			pages.Add(BuildMachine());
			pages.Add(BuildOptions());
			pages.Add(BuildProgress());
			pages.Add(BuildFinish());
			foreach (var p in pages)
			{
				p.Location = P(28, 86);
				p.Size = Z(604, 320);
				p.Visible = false;
				Controls.Add(p);
			}
			ResumeLayout(false);
			PerformLayout();
			Go(0);
		}

		static Label Text1(string text, int x, int y, int w, int h)
		{
			return new Label { Text = text, Location = P(x, y), Size = Z(w, h) };
		}

		static Label Hint(string text, int x, int y, int w, int h)
		{
			return new Label { Text = text, Location = P(x, y), Size = Z(w, h), ForeColor = Muted };
		}

		Panel BuildConnect()
		{
			var p = new Panel();
			p.Controls.Add(Text1("本向导会把这台电脑接入 ps-platform 渲染平台：安装渲染节点 Agent 并设置为自动运行。Agent 负责上报显卡与运行状态，并按平台的调度启动 UE 程序。", 0, 0, 604, 44));
			int y = 52;
			if (st.Embedded)
			{
				var tip = new Label { Text = "✔ 安装程序已包含平台地址与接入令牌（来自管理端下载链接），一般无需修改，直接点「下一步」。", Location = P(0, y), Size = Z(604, 40), ForeColor = OkColor, BackColor = Color.FromArgb(236, 250, 241), Padding = new Padding(S(8), S(6), S(8), S(4)) };
				p.Controls.Add(tip);
				y += 50;
			}
			if (st.InstalledDir != null)
			{
				var up = new Label { Text = "检测到本机已安装 Agent" + (string.IsNullOrEmpty(st.InstalledVersion) ? "" : "（版本 " + st.InstalledVersion + "）") + "：继续将升级程序并沿用现有设置。", Location = P(0, y), Size = Z(604, 22), ForeColor = Accent };
				p.Controls.Add(up);
				y += 30;
			}
			p.Controls.Add(Text1("平台地址", 0, y + 4, 90, 20));
			txtAddr = new TextBox { Location = P(96, y), Size = Z(380, 24), Text = Addr.Display(st.Http) };
			p.Controls.Add(txtAddr);
			p.Controls.Add(Hint("管理端「渲染机 / GPU → 接入渲染机」中显示的地址，例如 192.168.1.10:88", 96, y + 28, 500, 20));
			y += 58;
			p.Controls.Add(Text1("接入令牌", 0, y + 4, 90, 20));
			txtToken = new TextBox { Location = P(96, y), Size = Z(380, 24), Text = st.Token, UseSystemPasswordChar = true };
			chkShow = new CheckBox { Text = "显示", Location = P(486, y + 2), Size = Z(70, 22) };
			chkShow.CheckedChanged += (s, e) => txtToken.UseSystemPasswordChar = !chkShow.Checked;
			p.Controls.Add(txtToken);
			p.Controls.Add(chkShow);
			y += 40;
			btnCheck = new Button { Text = "检测连接", Location = P(96, y), Size = Z(96, 28) };
			btnCheck.Click += (s, e) => StartCheck(false);
			lblCheck = new Label { Location = P(202, y + 1), Size = Z(400, 44) };
			p.Controls.Add(btnCheck);
			p.Controls.Add(lblCheck);
			txtAddr.TextChanged += (s, e) => { checkOk = false; lblCheck.Text = ""; };
			txtToken.TextChanged += (s, e) => { checkOk = false; lblCheck.Text = ""; };
			return p;
		}

		Panel BuildMachine()
		{
			var p = new Panel();
			p.Controls.Add(Text1("机器名称", 0, 4, 90, 20));
			txtId = new TextBox { Location = P(96, 0), Size = Z(260, 24), Text = st.Id, MaxLength = 64 };
			p.Controls.Add(txtId);
			p.Controls.Add(Hint("在管理端「渲染机 / GPU」中显示，用于区分渲染机；同一平台中不能重复。只能包含字母、数字、- 和 _。", 96, 28, 500, 36));
			p.Controls.Add(Text1("UE 程序目录", 0, 76, 90, 20));
			lstDirs = new ListBox { Location = P(96, 72), Size = Z(400, 112), IntegralHeight = false, HorizontalScrollbar = true };
			foreach (string d in st.AllowExe) lstDirs.Items.Add(d);
			var add = new Button { Text = "添加目录…", Location = P(506, 72), Size = Z(96, 28) };
			var del = new Button { Text = "移除", Location = P(506, 106), Size = Z(96, 28) };
			add.Click += (s, e) =>
			{
				using (var f = new FolderBrowserDialog { Description = "选择 UE 打包程序所在的文件夹（包含子文件夹）", ShowNewFolderButton = false })
				{
					if (f.ShowDialog(this) != DialogResult.OK) return;
					foreach (object o in lstDirs.Items) if (Util.SamePath((string)o, f.SelectedPath)) return;
					lstDirs.Items.Add(f.SelectedPath);
				}
			};
			del.Click += (s, e) => { if (lstDirs.SelectedIndex >= 0) lstDirs.Items.RemoveAt(lstDirs.SelectedIndex); };
			p.Controls.AddRange(new Control[] { lstDirs, add, del });
			p.Controls.Add(Hint("选择 UE 打包程序所在的文件夹。这是安全白名单：平台只能启动这些文件夹（含子文件夹）中的程序；不选择则不限制（不推荐）。", 96, 190, 500, 40));
			return p;
		}

		Panel BuildOptions()
		{
			var p = new Panel();
			p.Controls.Add(Text1("安装位置", 0, 4, 90, 20));
			txtDir = new TextBox { Location = P(96, 0), Size = Z(400, 24), Text = st.Dir };
			var browse = new Button { Text = "浏览…", Location = P(506, -1), Size = Z(96, 28) };
			browse.Click += (s, e) =>
			{
				using (var f = new FolderBrowserDialog { Description = "选择安装位置（将在其中创建程序文件）", ShowNewFolderButton = true })
				{
					if (f.ShowDialog(this) != DialogResult.OK) return;
					string chosen = f.SelectedPath;
					// 选了已有内容的文件夹（如 D:\Apps）时，在其中新建 ps-platform-agent 子文件夹
					if (Installer.CheckDir(chosen) != null) chosen = Path.Combine(chosen, "ps-platform-agent");
					txtDir.Text = chosen;
				}
			};
			p.Controls.AddRange(new Control[] { txtDir, browse });

			// 平台启动 UE 时总会加 -RenderOffScreen（无窗口渲染），因此 Windows 服务（会话 0）也能出图：默认推荐服务方式
			p.Controls.Add(Text1("运行方式", 0, 52, 90, 20));
			rbService = new RadioButton { Text = "开机自动运行（Windows 服务，推荐）", Location = P(96, 50), Size = Z(500, 24), Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) };
			p.Controls.Add(rbService);
			p.Controls.Add(Hint("无需登录 Windows，开机即接入平台，适合无人值守的渲染机。UE 由平台以无窗口方式（-RenderOffScreen）在后台启动。", 114, 76, 488, 40));
			rbLogon = new RadioButton { Text = "登录 Windows 后自动运行", Location = P(96, 124), Size = Z(500, 24), Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) };
			p.Controls.Add(rbLogon);
			var lnk = new LinkLabel { Text = "在当前用户的桌面会话中运行。个别显卡驱动或 UE 插件在服务方式下无法出图时改用此方式；电脑重启后需登录 Windows（可设置 Windows 自动登录，运行 netplwiz）。", Location = P(114, 150), Size = Z(488, 40), ForeColor = Muted, LinkColor = Accent };
			lnk.LinkArea = new LinkArea(lnk.Text.IndexOf("设置 Windows 自动登录"), "设置 Windows 自动登录".Length);
			lnk.LinkClicked += (s, e) => { try { Process.Start(Util.Sys("netplwiz.exe")); } catch { } };
			p.Controls.Add(lnk);
			if (st.Mode == "logon") rbLogon.Checked = true; else rbService.Checked = true;
			return p;
		}

		Panel BuildProgress()
		{
			var p = new Panel();
			lblNow = new Label { Location = P(0, 0), Size = Z(604, 22), Text = "准备安装…" };
			bar = new ProgressBar { Location = P(0, 28), Size = Z(604, 20), Minimum = 0, Maximum = 100 };
			txtLog = new TextBox { Location = P(0, 60), Size = Z(604, 256), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(248, 249, 251), Font = new Font("Consolas", 9F) };
			p.Controls.AddRange(new Control[] { lblNow, bar, txtLog });
			return p;
		}

		Panel BuildFinish()
		{
			var p = new Panel();
			lblDone = new Label { Location = P(0, 4), Size = Z(604, 34), Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold) };
			lblDoneText = new Label { Location = P(0, 48), Size = Z(604, 150) };
			lnkLogs = new LinkLabel { Text = "打开日志文件夹", Location = P(0, 210), Size = Z(160, 22), LinkColor = Accent };
			lnkAdmin = new LinkLabel { Text = "打开平台管理端", Location = P(170, 210), Size = Z(160, 22), LinkColor = Accent };
			lnkLogs.LinkClicked += (s, e) => { try { if (Directory.Exists(resultLogDir)) Process.Start("explorer.exe", Util.Q(resultLogDir)); } catch { } };
			lnkAdmin.LinkClicked += (s, e) => { try { string h, w; if (Addr.Parse(txtAddr.Text, out h, out w)) Process.Start(h + "/admin/"); } catch { } };
			p.Controls.AddRange(new Control[] { lblDone, lblDoneText, lnkLogs, lnkAdmin });
			return p;
		}

		static readonly string[][] Titles = {
			new[] { "连接平台", "确认要接入的渲染平台" },
			new[] { "本机设置", "设置机器名称和允许启动的 UE 程序目录" },
			new[] { "安装选项", "选择安装位置和运行方式" },
			new[] { "正在安装", "请稍候，安装通常不超过一分钟" },
			new[] { "完成", "" },
		};

		void Go(int i)
		{
			if (i < 0 || i >= pages.Count) return;
			page = i;
			for (int k = 0; k < pages.Count; k++) pages[k].Visible = k == i;
			lblTitle.Text = Titles[i][0];
			lblSub.Text = Titles[i][1];
			lblStep.Text = i < 3 ? "第 " + (i + 1) + " 步，共 3 步" : "";
			btnBack.Visible = (i > 0 && i < 3) || (i == 4 && failed);
			btnBack.Text = i == 4 ? "< 返回修改" : "< 上一步";
			btnBack.Enabled = !checking;
			btnNext.Text = i == 2 ? "安装" : i == 4 ? "完成" : "下一步 >";
			btnNext.Enabled = i != 3 && !checking;
			btnCancel.Visible = i < 4;
			btnCancel.Enabled = i != 3;
		}

		void SetBusy(bool busy)
		{
			checking = busy;
			btnNext.Enabled = !busy;
			btnBack.Enabled = !busy;
			btnCheck.Enabled = !busy;
			Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
		}

		/** 后台检测平台连接；thenNext=true 时检测通过后自动进入下一步 */
		void StartCheck(bool thenNext)
		{
			string http, ws;
			if (!Addr.Parse(txtAddr.Text, out http, out ws))
			{
				ShowCheck(false, "请填写平台地址，例如 192.168.1.10:88");
				return;
			}
			if (txtToken.Text.Trim() == "")
			{
				ShowCheck(false, "请填写接入令牌（管理端「接入渲染机」中可复制）");
				return;
			}
			string token = txtToken.Text.Trim();
			SetBusy(true);
			ShowCheck(true, "正在检测…", Muted);
			var t = new Thread(() =>
			{
				bool ok;
				string msg = Probe.Check(http, token, out ok);
				BeginInvoke((Action)(() =>
				{
					SetBusy(false);
					checkOk = ok;
					checkedKey = http + "|" + token;
					ShowCheck(ok, msg);
					if (!thenNext) return;
					if (ok) Go(1);
					else if (MessageBox.Show(this, msg + "\n\n仍要继续安装吗？（安装后 Agent 会持续重试连接）", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes) Go(1);
				}));
			});
			t.IsBackground = true;
			t.Start();
		}

		void ShowCheck(bool ok, string msg, Color? color = null)
		{
			lblCheck.ForeColor = color ?? (ok ? OkColor : BadColor);
			lblCheck.Text = (color == null ? (ok ? "✔ " : "✘ ") : "") + msg;
		}

		void Next()
		{
			if (page == 0)
			{
				string http, ws;
				bool parsed = Addr.Parse(txtAddr.Text, out http, out ws);
				if (parsed && checkOk && checkedKey == http + "|" + txtToken.Text.Trim()) Go(1);
				else StartCheck(true);
				return;
			}
			if (page == 1)
			{
				txtId.Text = txtId.Text.Trim();
				if (!Util.ValidId(txtId.Text))
				{
					MessageBox.Show(this, "机器名称只能包含字母、数字、- 和 _（1-64 个字符）。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
					txtId.Focus();
					return;
				}
				if (lstDirs.Items.Count == 0 && MessageBox.Show(this, "没有选择 UE 程序目录：平台将可以让本机启动任意程序。\n建议添加 UE 打包程序所在的文件夹。\n\n仍要继续吗？", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
				Go(2);
				return;
			}
			if (page == 2)
			{
				string bad = Installer.CheckDir(txtDir.Text.Trim());
				if (bad != null)
				{
					MessageBox.Show(this, bad, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
					return;
				}
				StartInstall();
				return;
			}
			if (page == 4) { finished = true; Close(); }
		}

		InstallOptions Options()
		{
			var o = new InstallOptions();
			Addr.Parse(txtAddr.Text, out o.Http, out o.Ws);
			o.Token = txtToken.Text.Trim();
			o.Id = txtId.Text.Trim();
			o.Dir = Path.GetFullPath(txtDir.Text.Trim());
			o.Mode = rbService.Checked ? "service" : "logon";
			foreach (object d in lstDirs.Items) o.AllowExe.Add((string)d);
			return o;
		}

		void AppendLog(string line)
		{
			txtLog.AppendText(DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "  " + line + Environment.NewLine);
		}

		void StartInstall()
		{
			var o = Options();
			installing = true;
			txtLog.Clear();
			bar.Value = 0;
			Go(3);
			var ins = new Installer();
			ins.Log = m => BeginInvoke((Action)(() => AppendLog(m)));
			ins.Step = m => BeginInvoke((Action)(() => { lblNow.Text = m + "…"; AppendLog("— " + m); }));
			ins.Progress = v => BeginInvoke((Action)(() => bar.Value = Math.Max(0, Math.Min(100, v))));
			var t = new Thread(() =>
			{
				InstallResult r = null;
				string error = null;
				try { r = ins.Run(o); }
				catch (Exception e) { error = e.Message; }
				BeginInvoke((Action)(() => Finish(o, r, error)));
			});
			t.IsBackground = true;
			t.Start();
		}

		void Finish(InstallOptions o, InstallResult r, string error)
		{
			installing = false;
			result = r;
			resultLogDir = r != null ? r.LogDir : Path.Combine(o.Dir, "data", "logs");
			string addr = Addr.Display(o.Http);
			string how = o.Mode == "service" ? "开机自动运行（Windows 服务）" : "登录 Windows 后自动运行";
			failed = error != null;
			if (error != null)
			{
				AppendLog("安装失败：" + error);
				lblDone.Text = "✘ 安装失败";
				lblDone.ForeColor = BadColor;
				lblDoneText.Text = error + "\n\n可点「返回修改」调整设置后重试。";
				Go(4);
				return;
			}
			if (r.Connected)
			{
				lblDone.Text = "✔ 安装完成";
				lblDone.ForeColor = OkColor;
				lblDoneText.Text = "本机已作为「" + o.Id + "」接入平台 " + addr + "，可在管理端「渲染机 / GPU」中看到这台渲染机。\n\nAgent 已设置为" + how + "。\n修改设置：再次运行安装程序；卸载：Windows「设置 → 应用」中卸载「" + Util.Product + "」。";
			}
			else
			{
				lblDone.Text = "安装完成，但暂未连上平台";
				lblDone.ForeColor = Color.FromArgb(180, 110, 0);
				lblDoneText.Text = "原因：" + r.Reason + "\n\nAgent 已设置为" + how + "，会持续自动重试连接。请检查平台地址、接入令牌与网络；需要修改时再次运行安装程序即可。\n平台地址：" + addr;
			}
			Go(4);
		}

		protected override void OnFormClosing(FormClosingEventArgs e)
		{
			if (installing)
			{
				e.Cancel = true;
				return;
			}
			if (page < 3 && !finished && e.CloseReason == CloseReason.UserClosing &&
				MessageBox.Show(this, "确定退出安装？", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
				e.Cancel = true;
			base.OnFormClosing(e);
		}

		/** 界面检查：用示例数据把每一页画成 PNG */
		public static int Screenshots(string dir)
		{
			Directory.CreateDirectory(dir);
			var st = new SetupState();
			st.Http = "http://192.168.1.10:88"; st.Ws = "ws://192.168.1.10:88/agent"; st.Token = "example-token"; st.Embedded = true;
			st.Id = "render-01"; st.Dir = Util.DefaultDir; st.Mode = "service";
			st.AllowExe.Add(@"D:\UEProject\Windows");
			var w = new Wizard(st);
			w.StartPosition = FormStartPosition.Manual;
			w.Location = P(-4000, -4000);
			w.ShowInTaskbar = false;
			w.Show();
			Action<string> shot = name =>
			{
				Application.DoEvents();
				using (var bmp = new Bitmap(w.Width, w.Height))
				{
					w.DrawToBitmap(bmp, new Rectangle(0, 0, w.Width, w.Height));
					bmp.Save(Path.Combine(dir, name + ".png"), System.Drawing.Imaging.ImageFormat.Png);
				}
			};
			w.ShowCheck(true, "已连接平台（版本 " + BuildInfo.Version + "），接入令牌正确");
			shot("1-connect");
			w.Go(1); shot("2-machine");
			w.Go(2); shot("3-options");
			w.Go(3);
			w.lblNow.Text = "释放 Agent 程序…";
			w.bar.Value = 46;
			w.AppendLog("— 停止正在运行的 Agent");
			w.AppendLog("— 释放 Agent 程序");
			shot("4-installing");
			var o = new InstallOptions { Http = st.Http, Ws = st.Ws, Id = st.Id, Dir = st.Dir, Mode = "service" };
			var r = new InstallResult { Connected = true, LogDir = Path.Combine(st.Dir, "data", "logs") };
			w.Finish(o, r, null); shot("5-done");
			w.Finish(o, new InstallResult { Connected = false, Reason = "接入令牌不正确" }, null); shot("6-not-connected");
			w.finished = true;
			w.Close();
			return 0;
		}
	}
}
