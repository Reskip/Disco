import csv
import io
import json
import unittest
from knowledge_overview import inspect_csv, inspect_html, inspect_json, prepare_summary_sources


def source(text, format='json', **extra):
    return {'id': 'kb_' + 'a'*64, 'title': '原始资料.'+format, 'kind': 'document', 'format': format, 'markdown': text, **extra}


class LocalOverviewTests(unittest.TestCase):
    def test_large_keyed_json_is_fully_counted_without_enumerating_every_record(self):
        records = {f'站点{i}': {'lat': i/1000, 'lng': 100+i/1000, 'name': f'名称{i}'} for i in range(8033)}
        records['站点8032']['tailOnly'] = True
        result = prepare_summary_sources([source(json.dumps(records, ensure_ascii=False))])
        summary = result['deterministic']
        self.assertEqual(summary['summaryMode'], 'structured_overview')
        self.assertEqual(summary['topic'], '旅行与生活')
        self.assertIn('8033 条记录', summary['overview'])
        self.assertIn('tailOnly', summary['overview'])
        self.assertIn('8032', summary['overview'])  # Missing field count, not a dropped tail.
        self.assertNotIn('名称8032', summary['overview'])
        self.assertLess(len(summary['overview']), 3000)
        self.assertIn('/knowledge?entry=kb_'+'a'*64, result['content'])
        self.assertIn('未逐条解释记录', summary['overview'])

    def test_nested_collections_report_sizes_from_all_elements(self):
        result=inspect_json(json.dumps({'features':[{'coordinates':[i,i+1]} for i in range(73)]}))
        self.assertIn('features：出现 1 次，每次数组包含 73 至 73', result['overview'])
        self.assertIn('coordinates：出现 73 次，每次数组包含 2 至 2', result['overview'])

    def test_short_rules_and_unknown_chinese_conclusions_are_preserved_in_large_tables(self):
        records=[{'station':'北京南','id':index} for index in range(100)]
        records[-1].update({'rule':'所有图片和下载文件都永久保留。','unknownField':'人工修改的内容禁止自动总结覆盖。','policy':'Keep every original','remarks':'Review manually'})
        result=prepare_summary_sources([source(json.dumps(records,ensure_ascii=False))])
        self.assertNotIn('deterministic',result)
        for value in records[-1].values():
            if isinstance(value,str) and value!='北京南': self.assertIn(value,result['content'])
        plain=prepare_summary_sources([source(json.dumps(records[:-1],ensure_ascii=False))])
        self.assertIn('deterministic',plain)
        self.assertNotIn('北京南',plain['content'])

    def test_short_preferences_and_long_narrative_fields_remain_complete(self):
        tail='完整经验结论🙂\n'*8000+'LAST_NARRATIVE_SENTINEL'
        payload=json.dumps({'preference':'不吃辣','decisionText':'保留原件','details':tail},ensure_ascii=False)
        result=prepare_summary_sources([source(payload)])
        self.assertNotIn('deterministic',result)
        self.assertIn(tail,result['content'])
        self.assertIn('不吃辣',result['content'])
        self.assertIn('保留原件',result['content'])
        short=json.dumps({'preferred_format':'Markdown','custom_setting':'禁止覆盖人工修改'},ensure_ascii=False)
        short_result=prepare_summary_sources([source(short)])
        self.assertNotIn('deterministic',short_result)
        self.assertIn(short,short_result['content'])

    def test_csv_scans_every_record_and_reports_widths_dates_and_empty_values(self):
        text='time,latitude,longitude\n'+'2026-10-01T00:00:00Z,1,2\n'*20000+'2026-10-23T00:00:00+08:00,,3\n4,5\n'
        result=prepare_summary_sources([source(text,'csv')])
        overview=result['deterministic']['overview']
        self.assertIn('20002 条数据记录',overview)
        self.assertIn('与表头列数不同的记录：1 条',overview)
        self.assertIn('2026-10-22T16:00:00+00:00',overview)
        self.assertIn('空文本 1',overview)
        self.assertNotIn('2026-10-01T00:00:00Z,1,2',overview)

    def test_multiline_large_csv_narrative_fields_are_not_truncated(self):
        stream=io.StringIO(newline='')
        writer=csv.writer(stream)
        writer.writerow(['id','备注'])
        narrative='完整备注\n'*30000+'TAIL'
        writer.writerow([1,narrative])
        writer.writerow([2,'明确决定'])
        result=prepare_summary_sources([source(stream.getvalue(),'csv')])
        self.assertNotIn('deterministic',result)
        self.assertIn(narrative,result['content'])
        self.assertIn('原件第 2 至 30002 行',result['content'])
        self.assertIn('明确决定',result['content'])

    def test_script_heavy_html_is_a_local_overview_with_inert_complete_static_text(self):
        text='<html><head><title>轨迹对照</title></head><body><h1>完整说明</h1><canvas></canvas><p>尾部事实 &lt;img src=x onerror=bad()&gt;</p><script>'+('DO_NOT_EXECUTE_OR_SEND();'*20000)+'</script><p>最后的可见说明</p></body></html>'
        result=prepare_summary_sources([source(text,'html')])
        summary=result['deterministic']
        self.assertIn('最后的可见说明',summary['overview'])
        self.assertIn('\\<img',summary['overview'])
        self.assertNotIn('DO_NOT_EXECUTE_OR_SEND',summary['overview'])
        self.assertIn('未运行 JavaScript',summary['overview'])
        self.assertLess(len(summary['overview']),3000)

    def test_html_article_remains_whole_despite_large_scripts_and_hidden_elements(self):
        body='有用的结论与依据。'*20000+'文章尾部🙂'
        html='<html><head><title>文章</title></head><body><article><p>'+body+'</p><p hidden>HIDDEN_TEXT</p><style>CSS_NOT_CONTENT</style><script>'+('SCRIPT_NOT_CONTENT;'*40000)+'</script></article></body></html>'
        result=prepare_summary_sources([source(html,'html')])
        self.assertNotIn('deterministic',result)
        self.assertIn(body,result['content'])
        self.assertNotIn('HIDDEN_TEXT',result['content'])
        self.assertNotIn('SCRIPT_NOT_CONTENT',result['content'])
        self.assertNotIn('CSS_NOT_CONTENT',result['content'])

    def test_generated_attachment_wrapper_is_removed_but_human_heading_is_preserved(self):
        wrapped='# 原始资料.json\n\n[原始文件：原始资料.json](../assets/entry/original.json)\n\n[{"value":1}]\n'
        self.assertIn('deterministic',prepare_summary_sources([source(wrapped)]))
        human='# 人工修改\n重要决定不可丢失\n[{"value":1}]'
        result=prepare_summary_sources([source(human)])
        self.assertNotIn('deterministic',result)
        self.assertIn(human,result['content'])

    def test_malformed_data_falls_back_to_complete_narrative(self):
        for format,text in [('json','{"a": [1,2, incomplete LAST_SENTINEL'),('csv','name,notes\n1,"unclosed LAST_SENTINEL')]:
            result=prepare_summary_sources([source(text,format)])
            self.assertNotIn('deterministic',result)
            self.assertIn(text,result['content'])

    def test_mixed_sources_keep_narrative_and_both_source_links(self):
        narrative='# 经验\n\n短但明确的决定。\nLAST_SENTINEL'
        result=prepare_summary_sources([source('[{"lat":1,"lng":2}]'),source(narrative,'md',id='kb_'+'b'*64,kind='conversation')])
        self.assertNotIn('deterministic',result)
        self.assertIn(narrative,result['content'])
        self.assertIn('/knowledge?entry=kb_'+'a'*64,result['content'])
        self.assertIn('/knowledge?entry=kb_'+'b'*64,result['content'])

    def test_source_metadata_never_authorizes_paths_or_external_fetches(self):
        for invalid in [[],[source('[]',id='../other-user')],[source('[]',id='https://example.com')],[source('[]',kind='unknown')]]:
            with self.assertRaises(ValueError): prepare_summary_sources(invalid)
        text='<p>正文</p><script src="https://example.invalid/payload.js"></script><iframe src="file:///secret"></iframe>'
        result=inspect_html(text)
        self.assertIn('正文',result['overview'])
        self.assertNotIn('secret',result['overview'])


if __name__=='__main__': unittest.main()
