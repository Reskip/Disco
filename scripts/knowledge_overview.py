"""Pure local structure inspection. No filesystem, network, eval, or model access.

The original Markdown is never changed. Only derived summary input is prepared.
Structured overviews explicitly describe their scope; narrative fields stay whole.
"""

from collections import Counter
import csv
from datetime import datetime, timezone
from html.parser import HTMLParser
import io
import json
import math
import re

OVERVIEW_VERSION = "structured-overview-v1"
DETAIL_FIELDS = 80
NARRATIVE_KEYS = {"text", "content", "body", "markdown", "description", "notes", "note", "summary", "abstract", "question", "answer", "message", "prompt", "preference", "preferences", "preferred", "decision", "reason", "instructions", "lesson", "comment", "commentary", "transcript", "explanation", "rule", "rules", "policy", "purpose", "rationale", "definition", "requirement", "requirements", "recommendation", "recommendations", "remarks"}
NARRATIVE_CHINESE = re.compile("描述|备注|说明|原因|偏好|决定|结论|经验|内容|回答|问题|要求|背景|报告|约束|规则|策略|定义|建议|目的|依据")
SOURCE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\Z")


def md(value):
    """Prevent source labels from introducing active Markdown/HTML structure."""
    return re.sub(r"([\\`*{}_\[\]<>#|])", r"\\\1", str(value)).replace("\r", " ").replace("\n", " ")


def narrative(value, key=""):
    if not isinstance(value, str) or not value.strip():
        return False
    label = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(key)).lower().replace("_", " ")
    named = any(word in NARRATIVE_KEYS for word in label.split()) or bool(NARRATIVE_CHINESE.search(label))
    sentence = bool(re.search(r"[。！？；]", value)) and len(re.findall(r"[\u3400-\u9fff]", value)) >= 8
    return named or sentence or "\n" in value or (len(value) >= 240 and bool(re.search(r"\s|[\u3400-\u9fff]", value)))


def document_body(markdown):
    # Remove only the exact generated attachment wrapper, not arbitrary headings.
    return re.sub(r"\A\ufeff?# [^\r\n]+\r?\n\r?\n\[原始文件：[^\r\n]*\]\(\.\./(?:assets|attachments)/[^\r\n]*\)\r?\n\r?\n", "", markdown, count=1).lstrip("\ufeff")


def source_section(source, body):
    title = md(source["title"])
    return f"# 来源 {source['id']}：{title}\n\n来源：[{title}](/knowledge?entry={source['id']})\n\n{body}"


def field_table(stats, total):
    lines = ["| 字段 | 类型及数量 | 缺失记录 |", "| --- | --- | ---: |"]
    for name, counts in list(stats.items())[:DETAIL_FIELDS]:
        count = sum(counts.values())
        lines.append(f"| {md(name)} | {'、'.join(f'{md(kind)} {n}' for kind, n in counts.items())} | {max(0, total-count)} |")
    if len(stats) > DETAIL_FIELDS:
        lines.append(f"\n共识别 {len(stats)} 个字段，上表展示前 {DETAIL_FIELDS} 个；所有记录均已计数，其余字段仍保留在原件中。")
    return "\n".join(lines)


def value_type(value):
    if value is None: return "空值"
    if isinstance(value, bool): return "布尔值"
    if isinstance(value, int): return "整数"
    if isinstance(value, float): return "数值" if math.isfinite(value) else "非有限数值"
    if isinstance(value, str): return "文本" if value else "空文本"
    if isinstance(value, list): return "数组"
    return "对象"


def geographic(fields):
    labels = {str(field).lower() for field in fields}
    return bool(labels & {"lat", "latitude", "纬度", "纬度wgs84"}) and bool(labels & {"lng", "lon", "longitude", "经度", "经度wgs84"})


def inspect_json(text):
    data = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonstandard JSON")))
    records = None
    root = value_type(data)
    if isinstance(data, list):
        records = data
    elif isinstance(data, dict) and data and all(isinstance(value, dict) for value in data.values()):
        # A keyed record map (e.g. stations) is summarized by common field shapes,
        # never by enumerating thousands of top-level record names.
        values = list(data.values())
        common = set(values[0])
        for value in values[1:]: common.intersection_update(value)
        if common: records = values
    fields = {}
    if records is not None:
        for item in records:
            if isinstance(item, dict):
                for key, value in item.items(): fields.setdefault(key, Counter())[value_type(value)] += 1
            else: fields.setdefault("记录值", Counter())[value_type(item)] += 1
        record_count = len(records)
    elif isinstance(data, dict):
        for key, value in data.items(): fields[key] = Counter({value_type(value): 1})
        record_count = 1
    else:
        record_count = 1
        fields["根值"] = Counter({value_type(data): 1})
    scalars, arrays, objects, texts, collections = Counter(), 0, 0, [], {}
    stack = [(data, "$", "")]
    while stack:
        value, path, key = stack.pop()
        if isinstance(value, dict):
            objects += 1
            stack.extend((child, path + "[" + json.dumps(name, ensure_ascii=False) + "]", name) for name, child in reversed(list(value.items())))
        elif isinstance(value, list):
            arrays += 1
            collections.setdefault(key or '$', Counter())[len(value)] += 1
            stack.extend((value[index], f"{path}[{index}]", key) for index in range(len(value)-1, -1, -1))
        else:
            scalars[value_type(value)] += 1
            if narrative(value, key): texts.append(f"### 字段 {md(path)}\n\n{value}")
    description = f"JSON 根类型为{root}，识别 {record_count} 条记录、{len(fields)} 个记录字段。"
    # A small configuration/object with short string values may encode a clear
    # decision even without a field literally named "preference". Preserve it
    # whole instead of mistaking it for a large tabular dataset. Numeric-only
    # coordinate arrays still receive a no-model overview.
    if len(text.encode('utf-8')) <= 64000 and record_count < 20 and scalars.get('文本', 0):
        texts = ['### 完整 JSON 文本\n\n' + text]
    overview = f"## 结构化资料概览\n\n{description}\n\n完整遍历得到 {objects} 个对象、{arrays} 个数组、{sum(scalars.values())} 个标量值。\n\n{field_table(fields, record_count)}\n\n## 可用用途与范围\n\n可依据字段组织查询、筛选、关联或检查数据完整性；字段含义和业务结论仍需结合原始资料核实。此概览未逐条解释记录，也未检验每个数值的真实性。原始文件与全部记录均保留。"
    if collections:
        overview += '\n\n### 数组规模（同名字段合计）\n\n' + '\n'.join(f"- {md(key)}：出现 {sum(sizes.values())} 次，每次数组包含 {min(sizes)} 至 {max(sizes)} 个元素。" for key, sizes in list(collections.items())[:DETAIL_FIELDS])
        if len(collections)>DETAIL_FIELDS: overview += f'\n共 {len(collections)} 种数组字段，上面列出前 {DETAIL_FIELDS} 种；原件保留完整结构。'
    return {"overview": overview, "abstract": description, "narrative": "\n\n".join(texts), "topic": "旅行与生活" if geographic(fields) else "其他", "tags": ["JSON", "结构化资料"]}


def cell_type(value):
    if not value.strip(): return "空文本"
    if re.fullmatch(r"[+-]?\d+", value): return "整数"
    if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value): return "数值"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[T ][^\s]+)?", value):
        try: datetime.fromisoformat(value.replace("Z", "+00:00")); return "日期时间"
        except ValueError: pass
    return "文本"


def inspect_csv(text, delimiter=None):
    # Sniff only the delimiter; all rows are subsequently scanned, including tails.
    if delimiter is None:
        try: delimiter = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|").delimiter
        except csv.Error: delimiter = ","
    csv.field_size_limit(max(csv.field_size_limit(), len(text)))
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
    header = next(reader, None)
    if header is None: raise ValueError("Empty delimited data")
    labels = [f"{index+1}. {name or '未命名列'}" for index, name in enumerate(header)]
    stats, rows, widths, texts, dates = {}, 0, Counter(), [], {}
    for index, name in enumerate(labels): stats[name] = Counter()
    previous_line = reader.line_num
    for row in reader:
        rows += 1
        widths[len(row)] += 1
        for index, value in enumerate(row):
            name = labels[index] if index < len(labels) else f"{index+1}. 无表头列"
            kind = cell_type(value)
            stats.setdefault(name, Counter())[kind] += 1
            if narrative(value, header[index] if index < len(header) else ""):
                texts.append(f"### 数据记录 {rows}（原件第 {previous_line+1} 至 {reader.line_num} 行）· {md(name)}\n\n{value}")
            if kind == "日期时间":
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                aware = parsed.tzinfo is not None
                normalized = parsed.astimezone(timezone.utc).isoformat() if aware else parsed.isoformat()
                key = (name, aware)
                low, high = dates.get(key, (normalized, normalized))
                dates[key] = (min(low, normalized), max(high, normalized))
        previous_line = reader.line_num
    description = f"分隔文本按第一行作为表头完整扫描：{rows} 条数据记录、{len(header)} 个表头字段。"
    mismatch = sum(count for width, count in widths.items() if width != len(header))
    overview = f"## 结构化资料概览\n\n{description}\n\n分隔符：{'制表符' if delimiter == chr(9) else md(delimiter)}；与表头列数不同的记录：{mismatch} 条。\n\n{field_table(stats, rows)}"
    if dates:
        overview += "\n\n### 可识别的时间范围\n\n" + "\n".join(f"- {md(name)}：{low} 至 {high}（{'统一为 UTC' if aware else '原件未注明时区'}）。" for (name, aware), (low, high) in dates.items())
    overview += "\n\n## 可用用途与范围\n\n可按表头筛选、统计或关联记录。第一行被视为表头，原件若没有表头需重新确认字段；此概览未逐条解释数据或推断轨迹、覆盖、准确性等业务结论。全部行与原件均保留。"
    return {"overview": overview, "abstract": description, "narrative": "\n\n".join(texts), "topic": "旅行与生活" if geographic(header) else "其他", "tags": ["表格数据", "结构化资料"]}


class StaticHTML(HTMLParser):
    """Extract static text only. Never resolve URLs, stylesheets or JavaScript."""
    BLOCK = {"p", "div", "section", "article", "main", "header", "footer", "aside", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "table", "pre", "blockquote"}
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    EXCLUDED = {"script", "style", "template", "noscript"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.text, self.titles = [], [], []
        self.tags, self.script_chars, self.style_chars, self.links = Counter(), 0, 0, 0
    def excluded(self): return any(hidden for _, hidden in self.stack)
    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        hidden = tag in self.EXCLUDED or "hidden" in attributes or attributes.get("aria-hidden", "").lower() == "true" or bool(re.search(r"(?:display\s*:\s*none|visibility\s*:\s*hidden)", attributes.get("style", ""), re.I))
        self.tags[tag] += 1
        if not self.excluded() and not hidden and tag in self.BLOCK: self.text.append("\n")
        if tag == "a" and attributes.get("href"): self.links += 1
        if not self.excluded() and not hidden and tag == "img" and attributes.get("alt"): self.text.append("[图像替代文字：" + attributes['alt'] + "]")
        if tag not in self.VOID: self.stack.append((tag, hidden))
    def handle_endtag(self, tag):
        if not self.excluded() and tag in self.BLOCK: self.text.append("\n")
        for index in range(len(self.stack)-1, -1, -1):
            if self.stack[index][0] == tag:
                self.stack = self.stack[:index]
                break
    def handle_data(self, data):
        names = {tag for tag, _ in self.stack}
        if "script" in names: self.script_chars += len(data)
        elif "style" in names: self.style_chars += len(data)
        if "title" in names: self.titles.append(data)
        if not self.excluded() and "head" not in names: self.text.append(data)


def inspect_html(text):
    parser = StaticHTML()
    parser.feed(text)
    parser.close()
    body = "".join(parser.text).strip()
    title = "".join(parser.titles).strip()
    description = f"HTML 静态文档包含 {len(body)} 个正文字符、{parser.tags['script']} 段脚本、{parser.links} 个链接。"
    # Keep literal HTML-like text inert in deterministic Markdown notes.
    rendered = re.sub(r"([\\`*{}_\[\]<>#|])", r"\\\1", body)
    overview = f"## 结构化资料概览\n\n{description}\n\n页面标题：{md(title) if title else '未提供'}。脚本文本 {parser.script_chars} 字符，样式文本 {parser.style_chars} 字符；包含 {parser.tags['canvas']} 个 canvas、{parser.tags['svg']} 个 SVG、{parser.tags['table']} 个表格。\n\n## 静态正文（完整提取）\n\n{rendered or '未提取到静态正文。'}\n\n## 可用用途与范围\n\n可用于定位页面主题、静态说明与交互组件，并返回原件查看。未运行 JavaScript、未加载外部资源、未计算 CSS；动态生成或样式控制的显示内容无法据此确认。脚本内数据未逐条解读，不能据此声称已验证地图、轨迹或计算结果。原始 HTML 完整保留。"
    # Static articles remain complete narrative inputs even when bundled scripts
    # are large. A script-heavy app shell has an honest local overview instead.
    application = parser.script_chars > max(2000, len(body)*5) and (parser.tags['canvas'] or parser.tags['svg'] or len(body)<400) and not parser.tags['article']
    return {"overview": overview, "abstract": description, "narrative": "" if application or not body else body, "topic": "软件与系统", "tags": ["HTML", "结构化资料"]}


def prepare_summary_sources(sources):
    """Return complete prepared content and an optional no-model overview.

    Invalid source metadata fails closed. Unrecognized/invalid document formats
    keep their entire Markdown as narrative rather than silently losing content.
    """
    if not isinstance(sources, list) or not sources: raise ValueError("Invalid summary sources")
    prepared, reports, all_structured = [], [], True
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get('id'), str) or not SOURCE_ID.fullmatch(source['id']) or not isinstance(source.get('title'), str) or not isinstance(source.get('markdown'), str) or source.get('kind') not in {'document', 'conversation', 'note'}:
            raise ValueError("Invalid summary source")
        raw = source['markdown']
        format = str(source.get('format') or '').lower().lstrip('.')
        report = None
        if source['kind'] == 'document':
            body = document_body(raw)
            try:
                if format == 'json': report = inspect_json(body)
                elif format in {'csv', 'tsv'}: report = inspect_csv(body, '\t' if format == 'tsv' else None)
                elif format in {'html', 'htm'}: report = inspect_html(body)
            except (ValueError, csv.Error, RecursionError):
                pass
        if report:
            # HTML overview already contains its whole static narrative.
            content = report['overview']
            if report['narrative'] and format not in {'html', 'htm'}:
                content += '\n\n## 叙述字段（完整保留）\n\n' + report['narrative']
            all_structured = all_structured and not report['narrative']
            reports.append(report)
        else:
            content, all_structured = raw, False
        prepared.append(source_section(source, content))
    content = '\n\n---\n\n'.join(prepared)
    result = {'content': content}
    if all_structured:
        topic = reports[0]['topic'] if len({r['topic'] for r in reports}) == 1 else '其他'
        title = re.sub(r'\.(?:json|csv|tsv|html?)$', '', sources[0]['title'], flags=re.I) if len(sources)==1 else '多份资料'
        result['deterministic'] = {'title': title[:60]+'资料概览', 'topic': topic, 'tags': list(dict.fromkeys(tag for report in reports for tag in report['tags']))[:6],
            'abstract': f"已在本地生成 {len(sources)} 份资料的结构概览，未调用生成模型；这是格式、规模和可用字段说明，不代表逐条提炼了全部知识。",
            'overview': content, 'summaryMode': 'structured_overview'}
    return result
