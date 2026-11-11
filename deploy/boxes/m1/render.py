import sys, re
from markdown_it import MarkdownIt
src, out = sys.argv[1], sys.argv[2]
md = MarkdownIt("commonmark").enable("table")
text = open(src, encoding="utf-8").read()
title = (re.search(r"^# (.+)$", text, re.M) or [None, "Mumbo Assistant Design"])[1].split(":")[0]
body = md.render(text)
body = body.replace("<table>", '<div class="tbl"><table>').replace("</table>", "</table></div>")
body = body.replace("<strong>[founder]</strong>", '<span class="tag f">founder</span>').replace("<strong>[my call]</strong>", '<span class="tag m">my call</span>')
body = re.sub(r"<strong>\[founder: ([^\]]+)\]</strong>", r'<span class="tag f">founder: \1</span>', body)
body = re.sub(r"<strong>\[my call([^\]]*)\]</strong>", r'<span class="tag m">my call\1</span>', body)
css = """
:root{--bg:#fff;--page:rgb(249,250,251);--l1:rgb(15,17,21);--l2:rgb(97,102,107);--l3:rgb(129,133,140);--b3:rgba(0,0,0,.12);--sel:rgb(245,246,247);--accent:rgb(65,118,230);--new:rgb(124,58,237)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:rgb(21,21,23);--page:rgb(27,27,28);--l1:rgb(249,250,251);--l2:rgb(207,211,214);--l3:rgb(173,178,184);--b3:rgba(255,255,255,.16);--sel:rgb(53,54,56);--accent:rgb(122,170,255);--new:rgb(167,139,250)}}
:root[data-theme="dark"]{--bg:rgb(21,21,23);--page:rgb(27,27,28);--l1:rgb(249,250,251);--l2:rgb(207,211,214);--l3:rgb(173,178,184);--b3:rgba(255,255,255,.16);--sel:rgb(53,54,56);--accent:rgb(122,170,255);--new:rgb(167,139,250)}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--l1);font:14px/24px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px;background:var(--bg);min-height:100vh}
h1{font-size:24px;line-height:32px;font-weight:600;margin:0 0 12px}h2{font-size:19px;line-height:28px;font-weight:600;margin:36px 0 10px;padding-top:12px;border-top:.5px solid var(--b3)}h3{font-size:15px;font-weight:600;margin:22px 0 6px}
p{margin:0 0 12px}ul,ol{margin:0 0 12px;padding-left:22px}li{margin:3px 0}a{color:var(--accent)}
code{font:12px/19px "SF Mono","JetBrains Mono",Menlo,Consolas,monospace;background:var(--sel);border-radius:4px;padding:1px 4px;overflow-wrap:anywhere}
.tbl{overflow-x:auto;border:.5px solid var(--b3);border-radius:12px;margin:12px 0}table{width:100%;border-collapse:collapse;font-size:13px;line-height:21px;min-width:560px}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:.5px solid var(--b3)}th{color:var(--l3);font-weight:500;font-size:12px}tr:last-child td{border-bottom:none}
.tag{display:inline-block;font-size:11px;line-height:17px;font-weight:500;padding:0 7px;border-radius:999px;white-space:nowrap;vertical-align:1px}
.tag.f{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}.tag.m{background:color-mix(in srgb,var(--new) 14%,transparent);color:var(--new)}
.key{color:var(--l2);font-size:13px;margin:0 0 20px}
"""
html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title><style>{css}</style></head><body><main>
<p class="key">Legend: <span class="tag f">founder</span> decided by you · <span class="tag m">my call</span> decided by the designer, yours to overturn.</p>
{body}</main></body></html>"""
open(out, "w", encoding="utf-8").write(html)
