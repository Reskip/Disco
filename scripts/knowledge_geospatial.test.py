import importlib.util
import hashlib
import io
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("knowledge_geospatial", pathlib.Path(__file__).with_name("knowledge_geospatial.py"))
geo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geo)


class GeospatialTests(unittest.TestCase):
    def parse(self, text, format="gpx"):
        return geo.extract_geospatial(io.BytesIO(text.encode()), format)

    def test_gpx_names_descriptions_counts_and_original_unchanged(self):
        raw = b'<gpx xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Document</name><desc>Full description.</desc></metadata><trk><name>Morning run</name><trkseg><trkpt lat="1.23456789" lon="2.3456789"><ele>1234.56</ele></trkpt><trkpt lat="3" lon="4"/></trkseg></trk></gpx>'
        stream = io.BytesIO(raw)
        result = geo.extract_geospatial(stream, "gpx")
        self.assertEqual(stream.getvalue(), raw)
        self.assertEqual(result["counts"]["trkpt"], 2)
        self.assertIn("Morning run", result["overview"])
        self.assertIn("Full description.", result["overview"])
        self.assertNotIn("1.23456789", result["overview"])
        self.assertNotIn("1234.56", result["overview"])

    def test_kml_names_html_inert_extended_data_and_gx(self):
        result = self.parse('''<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>地图</name><Placemark><name>车站</name><description><![CDATA[<p>完整说明</p><script>steal()</script><img src="https://invalid"><p>第二段</p>]]></description><ExtendedData><Data name="policy"><value>所有图片和下载文件都永久保留。</value></Data><Data name="coordinates"><value>123.456,55.678</value></Data></ExtendedData><gx:Track><gx:coord>88.123 66.345 7</gx:coord></gx:Track></Placemark><NetworkLink><Link><href>https://invalid</href></Link></NetworkLink></Document></kml>''', "kml")
        self.assertEqual(result["counts"]["Track"], 1)
        self.assertEqual(result["counts"]["coord"], 1)
        self.assertIn("车站", result["overview"])
        self.assertIn("第二段", result["overview"])
        self.assertIn("所有图片和下载文件都永久保留。", result["overview"])
        for absent in ["steal()", "https://invalid", "123.456", "88.123", "<img"]:
            self.assertNotIn(absent, result["overview"])

    def test_xml_declared_unicode_encoding_is_respected(self):
        raw = '<?xml version="1.0" encoding="UTF-16"?><gpx><metadata><name>中文轨迹</name></metadata></gpx>'.encode('utf-16')
        result = geo.extract_geospatial(io.BytesIO(raw), 'gpx')
        self.assertIn('中文轨迹', result['overview'])

    def test_nested_description_and_name_after_description(self):
        result = self.parse('<kml><Document><Placemark><description>前文<b>加粗</b>后文</description><name>后置名称</name></Placemark></Document></kml>', "kml")
        self.assertIn("前文加粗后文", result["overview"])
        self.assertIn("后置名称", result["overview"])

    def test_dtd_entities_and_external_references_rejected(self):
        for text in ['<!DOCTYPE gpx><gpx/>', '<!DOCTYPE gpx [<!ENTITY x "secret">]><gpx><name>&x;</name></gpx>', '<!DOCTYPE gpx SYSTEM "file:///private"><gpx/>']:
            with self.subTest(text=text), self.assertRaises(geo.GeospatialParseError) as caught:
                self.parse(text)
            self.assertEqual(caught.exception.code, "xml_security")

    def test_malformed_or_wrong_root_is_clear_failure(self):
        for text, code in [('<gpx><trk>', 'xml_malformed'), ('<html/>', 'root'), ('<gpx xmlns="https://invalid"/>', 'root')]:
            with self.subTest(text=text), self.assertRaises(geo.GeospatialParseError) as caught:
                self.parse(text)
            self.assertEqual(caught.exception.code, code)
            self.assertIn("原件已完整保留", str(caught.exception))

    def test_large_point_table_stays_out_of_projection(self):
        report = self.parse('<gpx><trk><name>长轨迹</name><trkseg>' + '<trkpt lat="12.3456789" lon="98.7654321"/>' * 20000 + '</trkseg></trk></gpx>')
        projection = geo.render_geospatial_projection(report)
        self.assertEqual(report['counts']['trkpt'], 20000)
        self.assertLess(len(projection), 2500)
        self.assertNotIn('12.3456789', projection)

    def test_complete_long_description_is_not_truncated(self):
        description = '完整说明与用户决定。\n' * 3000 + '最后一句也保留。'
        report = self.parse('<gpx><metadata><desc>' + description + '</desc></metadata></gpx>')
        self.assertIn(description, report['overview'])

    def test_missing_secure_parser_has_no_unsafe_fallback(self):
        import builtins
        original_import = builtins.__import__
        def guarded_import(name, *args, **kwargs):
            if name.startswith('defusedxml'):
                raise ImportError('synthetic missing dependency')
            return original_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=guarded_import), self.assertRaises(geo.GeospatialParseError) as caught:
            self.parse('<gpx/>')
        self.assertEqual(caught.exception.code, 'dependency')
        self.assertIn('defusedxml', str(caught.exception))

    def test_only_unchanged_versioned_projection_becomes_local_overview(self):
        report = self.parse('<gpx><trk><name>中文轨迹🙂</name></trk></gpx>')
        rendered = geo.render_geospatial_projection(report)
        markdown = '# 原件标题\n\n' + rendered
        attestation = {'kind': 'geospatial', 'version': 1, 'contentHash': hashlib.sha256(markdown.encode()).hexdigest()}
        self.assertEqual(geo.read_geospatial_projection(rendered + '\n', 'gpx', attestation, markdown)['overview'], report['overview'])
        self.assertIsNone(geo.read_geospatial_projection(rendered, 'gpx'))
        self.assertIsNone(geo.read_geospatial_projection(rendered, 'kml', attestation, markdown))
        self.assertIsNone(geo.read_geospatial_projection('# 用户写的 Markdown', 'gpx', attestation, markdown))
        self.assertIsNone(geo.read_geospatial_projection(rendered.replace('中文轨迹', '人工改写'), 'gpx', attestation, markdown))
        self.assertIsNone(geo.read_geospatial_projection(rendered, 'gpx', attestation, markdown + '人工新增'))
        self.assertIsNone(geo.read_geospatial_projection(rendered.replace('"version":1', '"version":2'), 'gpx', attestation, markdown))
        windows_body = rendered.replace('\n', '\r\n')
        windows_attestation = {**attestation, 'contentHash': hashlib.sha256(windows_body.encode()).hexdigest()}
        self.assertEqual(geo.read_geospatial_projection(windows_body, 'gpx', windows_attestation, windows_body)['overview'], report['overview'])


if __name__ == '__main__':
    unittest.main()
