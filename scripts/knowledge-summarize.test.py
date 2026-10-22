import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
import subprocess
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("knowledge_summarize", Path(__file__).with_name("knowledge-summarize.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SummaryProviderTests(unittest.TestCase):
    def test_one_completion_receives_the_entire_archive_without_tools(self):
        archive = "完整原始记录🙂\n" * 100 + "LAST_SENTINEL"
        calls = []

        class FakeVLM:
            def __init__(self, **configuration):
                self.configuration = configuration

            def get_completion(self, **arguments):
                calls.append(arguments)
                return json.dumps({"abstract": "简短摘要", "overview": "# 详细摘要\n末尾也包含在输入中"})

            def close(self):
                pass

        with patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=FakeVLM)}):
            result = module.summarize(archive, {"vlm": {"provider": "openai-codex", "model": "approved-model"}})
        self.assertEqual(len(calls), 1)
        self.assertNotIn("tools", calls[0])
        self.assertEqual(json.loads(calls[0]["messages"][1]["content"])["archive"], archive)
        self.assertEqual(result["abstract"], "简短摘要")

    def test_long_archive_is_losslessly_mapped_then_organized_and_resumes_from_cache(self):
        archive = "资料与决定🙂\n" * 8000 + "TAIL_SENTINEL"
        calls = []
        class FakeVLM:
            def __init__(self, **configuration): pass
            def get_completion(self, **arguments):
                payload = json.loads(arguments["messages"][1]["content"])
                calls.append(payload)
                return json.dumps({"title": "长期知识", "topic": "软件与系统", "tags": ["决定"], "abstract": "摘要", "overview": "## 已确认决定\n保留来源与结论。"})
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=FakeVLM)}), patch.object(module.time, "sleep"):
            config = {"vlm": {"provider": "openai-codex", "model": "approved-model"}}
            result = module.summarize(archive, config, cache_dir=Path(directory))
            self.assertEqual("".join(call["archive"] for call in calls if "archive" in call), archive)
            self.assertTrue(all(len(call["archive"].encode("utf-8")) <= module.CHUNK_BYTES for call in calls if "archive" in call))
            self.assertIn("sections", calls[-1])
            self.assertEqual(result["topic"], "软件与系统")
            count = len(calls)
            module.summarize(archive, config, cache_dir=Path(directory))
            self.assertEqual(len(calls), count)

    def test_failed_batch_resume_does_not_repeat_completed_cloud_calls(self):
        archive = "A" * (module.CHUNK_BYTES * 2 + 5)
        calls = []
        fail = True
        class FakeVLM:
            def __init__(self, **configuration): pass
            def get_completion(self, **arguments):
                payload = json.loads(arguments["messages"][1]["content"])
                calls.append(payload)
                if fail and payload.get("section") == 2:
                    raise RuntimeError("temporary provider failure")
                return '{"abstract":"saved","overview":"completed partial result"}'
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=FakeVLM)}), patch.object(module.time, "sleep"):
            config = {"vlm": {"provider": "openai-codex"}}
            with self.assertRaises(RuntimeError): module.summarize(archive, config, cache_dir=Path(directory))
            fail = False
            module.summarize(archive, config, cache_dir=Path(directory))
            self.assertEqual(sum(call.get("section") == 1 for call in calls), 1)
            self.assertEqual(sum(call.get("section") == 2 for call in calls), 2)

    def test_source_reference_survives_a_split_in_the_middle_of_one_source(self):
        source_a, source_b = "kb_" + "a" * 64, "kb_" + "b" * 64
        content = f"# 来源 {source_a}：方案记录\n" + "资料" * 1000 + f"\n# 来源 {source_b}：测试记录\n" + "结果" * 1000
        chunks = module.split_content(content, 500)
        contexts = module.source_contexts(content, chunks)
        self.assertEqual(contexts[1][0]["id"], source_a)
        self.assertEqual(contexts[-1][0]["url"], "/knowledge?entry=" + source_b)
        self.assertEqual("".join(chunks), content)

    def test_deleted_entry_cannot_be_recreated_by_a_late_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            tombstone = Path(directory) / "deleted"
            cache = Path(directory) / "entry"
            class FakeVLM:
                def __init__(self, **configuration): pass
                def get_completion(self, **arguments):
                    tombstone.write_text("")
                    return '{"abstract":"late","overview":"late completion"}'
                def close(self): pass
            with patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=FakeVLM)}):
                with self.assertRaisesRegex(module.SummaryFailure, "CANCELLED"):
                    module.summarize("synthetic", {"vlm": {"provider": "openai-codex"}}, cache_dir=cache, tombstone=tombstone)
                self.assertFalse(cache.exists())

    def test_unapproved_endpoint_or_api_key_cannot_receive_the_archive(self):
        with patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=lambda **_: self.fail("unexpected model call"))}):
            for provider in [
                {"provider": "openai"},
                {"provider": "openai-codex", "api_base": "https://example.com"},
                {"provider": "openai-codex", "api_key": "not-subscription-auth"},
            ]:
                with self.assertRaises(ValueError):
                    module.summarize("private archive", {"vlm": provider})

    def test_complete_json_wrappers_are_accepted_but_partial_or_ambiguous_results_are_not(self):
        valid = '{"abstract":"summary","overview":"note"}'
        self.assertEqual(module.parse_summary("```json\n" + valid + "\n```")["overview"], "note")
        self.assertEqual(module.parse_summary("结果：\n" + valid)["overview"], "note")
        for invalid in [valid[:-1], valid + valid, '{"broken":' + valid, '[' + valid + ']', '{"overview":"bad\nJSON","abstract":"a"}']:
            with self.subTest(invalid=invalid), self.assertRaises(module.SummaryFailure) as raised:
                module.parse_summary(invalid)
            self.assertEqual(raised.exception.code, "SUMMARY_FORMAT_INVALID")
        with self.assertRaises(module.SummaryFailure) as raised: module.parse_summary("  ")
        self.assertEqual(raised.exception.code, "SUMMARY_EMPTY")

    def test_stream_failure_and_incomplete_outputs_cannot_masquerade_as_success(self):
        class Stream:
            closed = False
            def __init__(self, events): self.events = events
            def __iter__(self): return iter(self.events)
            def close(self): self.closed = True
        text = {"type": "response.output_text.delta", "delta": '{"abstract":"plausible","overview":"partial"}'}
        for terminal, code in [
            ({"type": "response.failed", "response": {"error": {"code": "usage_limit_reached", "message": "SECRET"}}}, "SUMMARY_RATE_LIMITED"),
            ({"type": "response.failed", "response": {"error": {"code": "model_not_found"}}}, "SUMMARY_MODEL_UNAVAILABLE"),
            ({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max_output_tokens"}}}, "SUMMARY_INCOMPLETE"),
            ({"type": "error", "code": "invalid_api_key", "message": "SECRET"}, "SUMMARY_AUTH_REQUIRED"),
            (None, "SUMMARY_INCOMPLETE"),
            ({"type": "response.completed"}, "SUMMARY_INCOMPLETE"),
        ]:
            stream = Stream([text] + ([terminal] if terminal else []))
            with self.subTest(code=code), self.assertRaises(module.SummaryFailure) as raised:
                list(module.checked_events(stream))
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("SECRET", str(raised.exception))
            self.assertTrue(stream.closed)
        stream = Stream([text, {"type": "response.completed", "response": {"status": "completed"}}])
        self.assertEqual(len(list(module.checked_events(stream))), 2)
        self.assertTrue(stream.closed)

    def test_sdk_guard_is_restored_and_catches_adapter_ignored_terminal_event(self):
        class Responses:
            def create(self, **kwargs):
                return iter([{"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max_output_tokens"}}}])
        original = Responses.create
        with patch.dict("sys.modules", {"openai.resources.responses": SimpleNamespace(Responses=Responses)}):
            with self.assertRaises(module.SummaryFailure), module.checked_codex_responses():
                # This mirrors the installed adapter's iteration: without the
                # guard it ignores the event and returns an empty success.
                for _ in Responses().create(stream=True): pass
        self.assertIs(Responses.create, original)

    def test_structured_failures_keep_specific_causes_without_exposing_messages(self):
        class ProviderError(Exception): pass
        for kind, expected in [("authentication_error", "SUMMARY_AUTH_REQUIRED"), ("quota_exhausted", "SUMMARY_RATE_LIMITED"), ("model_not_found", "SUMMARY_MODEL_UNAVAILABLE"), ("input_too_large", "SUMMARY_INPUT_TOO_LARGE"), ("content_safety", "SUMMARY_CONTENT_BLOCKED")]:
            error = ProviderError("SECRET")
            error.kind = SimpleNamespace(value=kind)
            self.assertEqual(module.error_code(error), expected)
        outer = ProviderError("SECRET")
        outer.kind = SimpleNamespace(value="transient_network_error")
        outer.__cause__ = TimeoutError("SECRET")
        self.assertEqual(module.error_code(outer), "SUMMARY_TIMEOUT")
        outer.__cause__ = ValueError("SECRET")
        self.assertEqual(module.error_code(outer), "SUMMARY_NETWORK")
        outer.__cause__ = module.SummaryFailure("SUMMARY_INCOMPLETE", phase="stream")
        self.assertEqual(module.error_code(outer), "SUMMARY_INCOMPLETE")
        class CodexAuthError(RuntimeError): pass
        auth = CodexAuthError("SECRET")
        self.assertEqual(module.error_code(auth), "SUMMARY_AUTH_REQUIRED")
        auth.__cause__ = TimeoutError("SECRET")
        self.assertEqual(module.error_code(auth), "SUMMARY_TIMEOUT")

    def test_archive_only_is_a_strict_boolean_and_keeps_explanatory_content(self):
        base = {"abstract": "连通测试", "overview": "只有连通测试，没有可复用信息。", "topic": "新同义主题"}
        result = module.parse_summary(json.dumps({**base, "archiveOnly": True, "reason": "只需保留记录"}))
        self.assertTrue(result["archiveOnly"])
        self.assertEqual(result["topic"], "其他")
        self.assertEqual(result["reason"], "只需保留记录")
        self.assertNotIn("archiveOnly", module.parse_summary(json.dumps({**base, "archiveOnly": "true"})))

    def test_cache_storage_failure_is_reported_without_repeating_model_call(self):
        class FakeVLM:
            def __init__(self, **configuration): pass
            def get_completion(self, **arguments): return '{"abstract":"saved","overview":"completed result"}'
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=FakeVLM)}), patch.object(module.Path, "write_text", side_effect=OSError("PRIVATE PATH")):
            with self.assertRaises(module.SummaryFailure) as raised:
                module.summarize("synthetic", {"vlm": {"provider": "openai-codex"}}, cache_dir=Path(directory))
            self.assertEqual(raised.exception.code, "SUMMARY_CACHE_UNAVAILABLE")

    def test_structured_only_sources_do_not_initialize_a_model_or_require_credentials(self):
        sources=[{"id":"data-source","title":"站点.json","kind":"document","format":"json","markdown":"[{\"lat\":1,\"lng\":2}]"}]
        with patch.dict("sys.modules", {"openviking_cli.utils.config.vlm_config": SimpleNamespace(VLMConfig=lambda **_: self.fail("unexpected model call"))}):
            result=module.summarize("legacy content remains compatible",{},sources=sources)
        self.assertEqual(result['summaryMode'],'structured_overview')
        self.assertIn('1 条记录',result['overview'])

    def test_standalone_helper_emits_local_overview_without_a_model_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'config.json'
            config.write_text('{}',encoding='utf-8')
            payload={'scope':'disco_'+'a'*32,'entry_id':'synthetic','content':'legacy','sources':[{'id':'data-source','title':'站点.json','kind':'document','format':'json','markdown':'[{"lat":1,"lng":2}]'}]}
            response=subprocess.run([sys.executable,str(Path(__file__).with_name('knowledge-summarize.py')),'--config',str(config)],input=json.dumps(payload).encode('utf-8'),capture_output=True,timeout=20)
            self.assertEqual(response.returncode,0,response.stdout.decode('utf-8'))
            self.assertEqual(json.loads(response.stdout)['summaryMode'],'structured_overview')
            self.assertFalse((Path(directory)/'summary-work').exists())

    def test_explicit_synthesis_and_mixed_sources_use_prepared_input_without_losing_narrative(self):
        sources=[{"id":"data-source","title":"数据.csv","kind":"document","format":"csv","markdown":"lat,lng\n1,2\n3,4\n"}]
        calls=[]
        class FakeVLM:
            def __init__(self,**configuration): pass
            def get_completion(self,**arguments):
                calls.append(json.loads(arguments['messages'][1]['content'])['archive'])
                return '{"abstract":"结果","overview":"保留范围与来源","summaryMode":"structured_overview"}'
            def close(self): pass
        with patch.dict("sys.modules",{"openviking_cli.utils.config.vlm_config":SimpleNamespace(VLMConfig=FakeVLM)}):
            result=module.summarize('legacy',{'vlm':{'provider':'openai-codex'}},sources=sources,force_synthesis=True)
            self.assertEqual(result['summaryMode'],'model')
            self.assertIn('2 条数据记录',calls[-1])
            self.assertNotIn('1,2\n3,4',calls[-1])
            text='完整叙述，包含结尾 LAST_SENTINEL'
            module.summarize('legacy',{'vlm':{'provider':'openai-codex'}},sources=sources+[{"id":"narrative-source","title":"决定","kind":"conversation","markdown":text}])
            self.assertIn(text,calls[-1])
            self.assertIn('/knowledge?entry=data-source',calls[-1])
            self.assertIn('/knowledge?entry=narrative-source',calls[-1])


if __name__ == "__main__":
    unittest.main()
