"""Local, inert GPX/KML reading projections; original coordinate files stay intact.

This module never opens paths/URLs or invokes a model. The caller supplies an
authorized binary stream. defusedxml is mandatory; there is no permissive fallback.
"""

from collections import Counter
import hashlib
from html.parser import HTMLParser
import json
import re


PROJECTION_VERSION = 1
_NAMESPACES = {
    "gpx": {"", "http://www.topografix.com/GPX/1/0", "http://www.topografix.com/GPX/1/1"},
    "kml": {"", "http://www.opengis.net/kml/2.2", "http://earth.google.com/kml/2.0", "http://earth.google.com/kml/2.1", "http://earth.google.com/kml/2.2"},
}
_GX = "http://www.google.com/kml/ext/2.2"
_LABELS = {
    "gpx": "GPX 文档", "metadata": "文档信息", "trk": "轨迹", "trkseg": "轨迹分段",
    "trkpt": "轨迹点", "rte": "路线", "rtept": "路线点", "wpt": "途经点",
    "kml": "KML 文档", "Document": "文档", "Folder": "文件夹", "Placemark": "地标",
    "Point": "点几何", "LineString": "线几何", "Polygon": "面几何",
    "MultiGeometry": "组合几何", "Track": "动态轨迹", "coord": "动态轨迹坐标记录",
    "coordinates": "坐标数据块", "ExtendedData": "扩展数据块", "NetworkLink": "外部链接声明",
}
_GROUPS = {"gpx", "metadata", "trk", "rte", "wpt", "kml", "Document", "Folder", "Placemark", "Track"}
_NARRATIVE_KEY = re.compile(r"description|desc|comment|note|remark|summary|purpose|rule|policy|说明|描述|备注|规则|结论|要求", re.I)
_MARKER = re.compile(r"\A<!-- disco-geospatial-projection:(\{[^\r\n]+\}) -->\r?\n")


class GeospatialParseError(ValueError):
    """Safe error category; the message never includes document text or paths."""

    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def _tag(value):
    if value.startswith("{"):
        return value[1:].split("}", 1)
    return "", value


class _PlainDescription(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "iframe", "object", "template"}:
            self.hidden.append(tag)
        if not self.hidden and tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
        elif tag in {"p", "div", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain_description(text):
    if "<" not in text:
        return text.strip()
    parser = _PlainDescription()
    parser.feed(text)
    parser.close()
    return re.sub(r"\n[ \t]*\n+", "\n\n", "".join(parser.parts)).strip()


def _md(value):
    return re.sub(r"([\\`*_{}\[\]<>#!|])", r"\\\1", str(value))


def _narrative(value, key):
    if not value.strip():
        return False
    # Numerical coordinate arrays do not become narrative just because a field
    # has a broad label. Keep such data only in the downloadable original.
    if re.fullmatch(r"[\s\d.,+\-eE\[\]():;]+", value):
        return False
    return bool(_NARRATIVE_KEY.search(key) or re.search(r"[。！？；]", value)
                or re.search(r"[A-Za-z]{2,}\s+[A-Za-z]{2,}", value)
                or (len(value) >= 120 and re.search(r"[\u3400-\u9fff]", value)))


def extract_geospatial(source, format):
    """Scan a binary stream completely; return no coordinates and no active HTML."""
    if format not in _NAMESPACES:
        raise GeospatialParseError("format", "仅支持 GPX 或 KML 地图文件。")
    try:
        from defusedxml.ElementTree import iterparse
        from defusedxml.common import DefusedXmlException
        from xml.etree.ElementTree import ParseError
    except ImportError as error:
        raise GeospatialParseError("dependency", "服务器地图解析依赖 defusedxml 尚未安装；原件已完整保留。") from error
    counts, stack, fields = Counter(), [], []
    capture = None
    try:
        for event, element in iterparse(source, events=("start", "end"), forbid_dtd=True,
                                       forbid_entities=True, forbid_external=True):
            namespace, name = _tag(element.tag)
            known = namespace in _NAMESPACES[format] or (format == "kml" and namespace == _GX)
            if event == "start":
                if not stack and (name != format or namespace not in _NAMESPACES[format]):
                    raise GeospatialParseError("root", "文件内容不是有效的 GPX/KML 文档；原件已完整保留。")
                parent = stack[-1] if stack else None
                group = parent["group"] if parent else None
                if known and name in _LABELS:
                    counts[name] += 1
                if known and name in _GROUPS:
                    group = {"kind": name, "number": counts[name], "name": ""}
                frame = {"element": element, "name": name, "known": known, "group": group}
                stack.append(frame)
                if capture is None and known and name in {"name", "desc", "cmt", "description", "Data", "SimpleData"}:
                    if name not in {"Data", "SimpleData"} or any(f["name"] == "ExtendedData" and f["known"] for f in stack[:-1]):
                        capture = frame
                continue
            frame = stack[-1]
            if frame is capture:
                parent = stack[-2] if len(stack) > 1 else None
                text = plain_description("".join(element.itertext()))
                if name == "name" and text:
                    if parent and parent["name"] in _GROUPS and frame["group"]:
                        frame["group"]["name"] = text
                    fields.append((frame["group"], "名称", text))
                elif name in {"desc", "cmt", "description"} and text:
                    fields.append((frame["group"], "描述" if name != "cmt" else "备注", text))
                elif name in {"Data", "SimpleData"}:
                    key = element.attrib.get("name", "未命名字段")
                    value = text if name == "SimpleData" else plain_description("\n".join("".join(child.itertext()) for child in element if _tag(child.tag)[1] == "value"))
                    if _narrative(value, key):
                        fields.append((frame["group"], "扩展说明：" + key, value))
                capture = None
            stack.pop()
            if capture is None:
                element.clear()
                if stack:
                    stack[-1]["element"].remove(element)
    except DefusedXmlException as error:
        raise GeospatialParseError("xml_security", "地图 XML 含 DTD、实体或外部引用，已拒绝解析；原件已完整保留。") from error
    except ParseError as error:
        raise GeospatialParseError("xml_malformed", "地图 XML 结构不完整或已损坏，无法解析；原件已完整保留。") from error
    if not counts[format]:
        raise GeospatialParseError("root", "文件内容不是有效的 GPX/KML 文档；原件已完整保留。")
    overview = ["## 地图与轨迹资料概览", "", f"格式：{format.upper()}。已完整扫描 XML 结构；此阅读视图不列出坐标表。", "", "### 结构规模", ""]
    overview.extend(f"- {label}：{counts[tag]}" for tag, label in _LABELS.items() if counts[tag])
    overview.extend(["", "### 名称与描述（完整提取）", ""])
    if not fields:
        overview.append("文件未提供可提取的名称或纯文本描述。")
    for group, field, value in fields:
        scope = _LABELS[group["kind"]] + f" {group['number']}" if group else "文档"
        if group and group["name"] and field != "名称":
            scope += "：" + group["name"].replace("\n", " ")
        overview.extend([f"#### {_md(scope)} · {_md(field)}", "", _md(value), ""])
    overview.extend(["### 阅读范围", "", "名称、描述及叙述性扩展字段用于检索；坐标、时间、高程及其他未展示字段完整保留在原始文件中，可下载查看。本地解析没有加载外部链接或资源、没有执行 HTML/脚本，未验证线路、距离、覆盖或坐标准确性。"])
    abstract = f"{format.upper()} 地图资料，含 {counts['trk'] + counts['rte']} 条轨迹或路线、{counts['Placemark']} 个地标；已提取名称、描述与结构计数，坐标保留在原件。"
    return {"version": PROJECTION_VERSION, "format": format, "counts": dict(counts), "overview": "\n".join(overview).strip(), "abstract": abstract}


def render_geospatial_projection(report):
    """An integrity-bound marker distinguishes parser output from arbitrary MD."""
    body = report["overview"].replace("\r\n", "\n").strip()
    metadata = {"version": PROJECTION_VERSION, "format": report["format"],
                "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(), "counts": report["counts"]}
    return "<!-- disco-geospatial-projection:" + json.dumps(metadata, separators=(",", ":")) + " -->\n" + body + "\n"


def read_geospatial_projection(text, format, projection=None, source_markdown=None):
    # The marker is not authority. Only a server-supplied parser attestation tied
    # to this exact full Markdown permits the no-model path. A human edit changes
    # the hash, and a user-authored marker without metadata cannot opt into it.
    if (not isinstance(projection, dict) or projection.get("kind") != "geospatial"
            or projection.get("version") != PROJECTION_VERSION or not isinstance(source_markdown, str)
            or hashlib.sha256(source_markdown.encode("utf-8")).hexdigest() != projection.get("contentHash")):
        return None
    match = _MARKER.match(text)
    if not match or format not in _NAMESPACES:
        return None
    try:
        metadata = json.loads(match.group(1))
        body = text[match.end():].replace("\r\n", "\n").strip()
        counts = metadata["counts"]
        if (metadata.get("version") != PROJECTION_VERSION or metadata.get("format") != format
                or set(metadata) != {"version", "format", "sha256", "counts"}
                or not isinstance(counts, dict) or not counts.get(format)
                or any(key not in _LABELS or type(value) is not int or value < 0 for key, value in counts.items())
                or hashlib.sha256(body.encode("utf-8")).hexdigest() != metadata.get("sha256")):
            return None
        return {"overview": body, "abstract": f"{format.upper()} 地图资料的本地结构概览；名称与描述可检索，完整坐标保留在原件。",
                "narrative": "", "topic": "旅行与生活", "tags": [format.upper(), "地图与轨迹", "结构化资料"]}
    except (ValueError, KeyError, TypeError):
        return None
