import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
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
                with self.assertRaisesRegex(RuntimeError, "SUMMARY_CANCELLED"):
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


if __name__ == "__main__":
    unittest.main()
