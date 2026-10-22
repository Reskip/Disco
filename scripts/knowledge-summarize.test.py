import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("knowledge_summarize", Path(__file__).with_name("knowledge-summarize.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SummaryProviderTests(unittest.TestCase):
    def test_one_completion_receives_the_entire_archive_without_tools(self):
        archive = "完整原始记录🙂\n" * 10000 + "LAST_SENTINEL"
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
