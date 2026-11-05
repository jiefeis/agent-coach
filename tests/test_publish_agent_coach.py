import copy
from contextlib import redirect_stdout, redirect_stderr
from email import policy
from email.parser import BytesParser
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request
import urllib.response
import zipfile

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).resolve().parents[1] / "tools/publish_agent_coach.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

TOKEN = "skh_SYNTHETIC_NOT_A_REAL_CREDENTIAL_0123456789"
NAMES = (
    "SKILL.md", "AGENTS.md", "CLAUDE.md", "README.md", "做法/1-建项目.md",
    "模板/AGENTS.模板.md", "模板/CLAUDE.模板.md", "模板/README.模板.md",
    "模板/docs/PROJECT_INDEX.模板.md", "工具/coach-check.mjs", "做法/共用.md",
    "讲解/五站总览.html", "做法/0-体检.md", "做法/0-修复复诊.md",
    "做法/2-新做-说清需求.md", "做法/2-SOP-拆开SOP.md", "做法/3-排表画图.md",
    "做法/4-一步一票.md", "做法/5-收尾交接.md", "做法/架构推荐表.md",
    "模板/docs/INTAKE-新做.模板.md", "模板/docs/INTAKE-SOP.模板.md",
    "模板/docs/run-flow.模板.md", "模板/docs/票.模板.md",
)
OWNER, SLUG, VERSION = "user_0fdf85d4", "agent-coach", "1.17.0"
ICON = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/27205dc2-3c4b-4854-85b1-8902f05745a3.png"


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="publish 合成-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.zip = self.root / "原包.zip"
        self.meta = self.root / "metadata.json"
        self.creds = self.root / "credentials.json"
        self.receipt = self.root / "agent-coach-1.17.0.submit.json"
        self.files = {n: ("fixture::" + n + "::原字节\r\n").encode() + b"\x00" for n in NAMES}
        self.metadata = {"owner": OWNER, "slug": SLUG, "version": VERSION,
                         "displayName": "Agent 搭建教练", "iconUrl": ICON,
                         "summary": "existing summary", "changelog": "合成验证，不实际发布"}
        self.meta.write_text(json.dumps(self.metadata, ensure_ascii=False), encoding="utf-8")
        self.creds.write_text(json.dumps({"version": 1, "orgs": {}, "user": {
            "host": "https://api.skillhub.cn", "token": TOKEN, "userId": 7, "handle": OWNER,
            "loggedInAt": "2026-11-05T00:00:00Z"}}), encoding="utf-8")
        self.patch = mock.patch.multiple(publisher, MEMBERS={n: (len(v), hashlib.sha256(v).hexdigest()) for n, v in self.files.items()},
                                         CREDENTIALS=self.creds)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.write_zip(self.files)
        self.auth = {"user": {"id": 7, "handle": OWNER, "role": "user"}}
        self.detail = {"slug": SLUG, "owner": {"handle": OWNER, "displayName": "Awake", "image": None},
                       "namespace": {"canonicalName": "@" + OWNER + "/" + SLUG, "handle": OWNER,
                                     "displayName": OWNER, "publicSlug": SLUG},
                       "latestVersion": {"version": "1.16.0", "changelog": "previous", "createdAt": 1},
                       "skill": {"slug": SLUG, "displayName": "Agent 搭建教练", "iconUrl": ICON,
                                 "summary": "existing summary", "summary_zh": "existing Chinese summary",
                                 "category": "ai-agent", "subCategories": [{"key": "agent-workflow", "name": "工作流编排"}],
                                 "tags": {"latest": "1.16.0"}, "labels": {"requires_api_key": "false"},
                                 "source": "community", "sourceUrl": None, "ext": None,
                                 "overviewMd": "", "hasOverview": False, "verified": False}}
        self.response = {"skillId": 123, "status": "pending_review", "slug": SLUG,
                         "version": VERSION, "owner": {"handle": OWNER}}
        self.calls = []
        self.post_error = None
        self.http_status = 200
        self.versions = {"versions": [{"version": "1.16.0"}], "nextCursor": None}

    def write_zip(self, files):
        with zipfile.ZipFile(self.zip, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in files.items():
                item = zipfile.ZipInfo(name)
                item.filename = name  # Preserve raw unsafe separators; Windows ZipInfo normalizes its constructor input.
                z.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED)
        raw = self.zip.read_bytes()
        publisher.ZIP_SIZE = len(raw)
        publisher.ZIP_SHA = hashlib.sha256(raw).hexdigest()

    def run_cli(self, submit=False, extra=()):
        output, errors = io.StringIO(), io.StringIO()
        args = [str(self.zip), "--metadata", str(self.meta)] + (["--submit"] if submit else []) + list(extra)
        with redirect_stdout(output), redirect_stderr(errors):
            code = publisher.main(args)
        text = output.getvalue() + errors.getvalue()
        self.assertTrue(TOKEN not in text, "credential echoed by CLI")
        return code, json.loads(output.getvalue())

    def fake_exchange(self, method, path, token, data=None, content_type=None):
        self.assertTrue(token == TOKEN, "wrong credential at transport boundary")
        self.calls.append((method, path))
        if method == "GET":
            replies = {"/api/v1/auth/me": self.auth, "/api/v1/skills/agent-coach": self.detail,
                       "/api/v1/skills/agent-coach/versions": self.versions}
            return 200, copy.deepcopy(replies[path])
        self.assertEqual(path, "/api/v1/community/skills/publish")
        message = BytesParser(policy=policy.default).parsebytes(
            ("Content-Type: " + content_type + "\r\n\r\n").encode() + data)
        parts = list(message.iter_parts())
        self.assertEqual(len(parts), 25)
        payload = json.loads(parts[0].get_payload(decode=True))
        self.assertEqual(payload["iconUrl"], ICON)
        self.assertEqual(payload["version"], "1.17.0")
        self.assertTrue("owner" not in payload and "token" not in payload)
        self.assertEqual(set(payload), {"slug", "version", "displayName", "iconUrl", "summary", "changelog"})
        decoded = {part.get_filename(): part.get_payload(decode=True) for part in parts[1:]}
        self.assertEqual(decoded, self.files)
        if self.post_error:
            raise self.post_error
        return self.http_status, copy.deepcopy(self.response)

    def without_unverified_metadata(self):
        # A hypothetical known-safe contract branch. The actual nonempty snapshot is tested to block.
        self.detail["skill"].update(category=None, subCategories=[], summary_zh="")

    def test_default_preflight_reads_neither_credentials_nor_network_and_preserves_zip(self):
        raw, stamp = self.zip.read_bytes(), self.zip.stat().st_mtime_ns
        original_open = Path.open

        def guarded(path, *args, **kwargs):
            if Path(path) == self.creds:
                raise AssertionError("credential read during offline preflight")
            return original_open(path, *args, **kwargs)

        with mock.patch.object(Path, "open", guarded), mock.patch.object(publisher, "exchange", side_effect=AssertionError("network in preflight")):
            code, result = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "offline_validated")
        self.assertEqual(result["fileCount"], 24)
        self.assertEqual({f["path"] for f in result["files"]}, set(NAMES))
        self.assertEqual((self.zip.read_bytes(), self.zip.stat().st_mtime_ns), (raw, stamp))
        self.assertFalse(self.receipt.exists())

    def test_wire_payload_contains_exactly_24_original_files_and_original_icon(self):
        files = publisher.read_package(self.zip)
        payload = publisher.read_metadata(self.meta)
        body, content_type = publisher.multipart(payload, files)
        m = BytesParser(policy=policy.default).parsebytes(("Content-Type: " + content_type + "\r\n\r\n").encode() + body)
        parts = list(m.iter_parts())
        self.assertEqual([p.get_param("name", header="content-disposition") for p in parts], ["payload"] + ["files"] * 24)
        self.assertEqual({p.get_filename(): p.get_payload(decode=True) for p in parts[1:]}, self.files)
        self.assertEqual(json.loads(parts[0].get_payload(decode=True)), {
            "slug": "agent-coach", "version": "1.17.0", "displayName": "Agent 搭建教练",
            "iconUrl": ICON, "summary": "existing summary", "changelog": "合成验证，不实际发布"})

    def test_hash_and_each_member_bytes_are_checked(self):
        self.zip.write_bytes(self.zip.read_bytes()[:-1] + b"x")
        code, result = self.run_cli()
        self.assertEqual((code, result["reason"]), (1, "zip_identity"))
        changed = dict(self.files); changed["AGENTS.md"] = b"different"
        self.write_zip(changed)
        code, result = self.run_cli()
        self.assertEqual((code, result["reason"]), (1, "member_identity"))

    def test_unsafe_paths_are_rejected_even_with_matching_synthetic_hashes(self):
        for name in ["../escape.md", "/absolute.md", "C:/escape.md", "a\\b.md", 'a"b.md', "a\r\nb.md", "a//b.md", "a./b.md"]:
            with self.subTest(path=name):
                files = dict(self.files); del files["README.md"]; files[name] = b"unsafe"
                self.write_zip(files)
                with mock.patch.object(publisher, "MEMBERS", {n: (len(v), hashlib.sha256(v).hexdigest()) for n, v in files.items()}):
                    code, result = self.run_cli()
                self.assertEqual((code, result["reason"]), (1, "unsafe_member_path"))

    def test_sidecar_cannot_become_a_25th_file(self):
        files = dict(self.files); files["metadata.json"] = b"{}"; self.write_zip(files)
        code, result = self.run_cli()
        self.assertEqual((code, result["reason"]), (1, "member_count"))

    def test_fixed_metadata_and_tags_type_fail_closed(self):
        for field, value in [("owner", "another_owner"), ("slug", "another-skill"), ("version", "1.18.0"),
                             ("displayName", "another name"), ("iconUrl", "https://other.invalid/icon.png"),
                             ("tags", {"latest": "1.16.0"})]:
            with self.subTest(field=field):
                m = dict(self.metadata); m[field] = value; self.meta.write_text(json.dumps(m), encoding="utf-8")
                code, result = self.run_cli()
                self.assertEqual((code, result["reason"]), (1, "metadata_" + field))

    def test_empty_optional_values_do_not_overwrite_fields_or_invent_license(self):
        m = dict(self.metadata, license=None, homepage="", tags=[]); self.meta.write_text(json.dumps(m), encoding="utf-8")
        payload = publisher.read_metadata(self.meta)
        self.assertTrue(all(k not in payload for k in ["license", "homepage", "tags"]))

    def test_matching_identity_submits_once_and_only_acknowledges_pending_review(self):
        self.without_unverified_metadata()
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["status"]), (0, "submitted_pending_review"))
        self.assertEqual(self.calls, [("GET", "/api/v1/auth/me"), ("GET", "/api/v1/skills/agent-coach"),
                                     ("GET", "/api/v1/skills/agent-coach/versions"), ("POST", "/api/v1/community/skills/publish")])
        self.assertIs(result["publicationVerified"], False)
        self.assertTrue(self.receipt.exists())

    def test_wrong_live_owner_never_reaches_publish(self):
        self.auth["user"]["handle"] = "another_owner"
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "owner_conflict"))
        self.assertTrue(all(m != "POST" for m, _ in self.calls))

    def test_changed_original_icon_or_public_target_version_blocks_publish(self):
        for field in ["icon", "version"]:
            detail = copy.deepcopy(self.detail)
            if field == "icon": detail["skill"]["iconUrl"] = "https://other.invalid/icon.png"
            else: detail["latestVersion"]["version"] = "1.17.0"
            with self.subTest(field=field), mock.patch.object(self, "detail", detail), mock.patch.object(publisher, "exchange", self.fake_exchange):
                code, result = self.run_cli(submit=True)
                self.assertEqual(code, 1)
                self.assertEqual(result["reason"], "icon_conflict" if field == "icon" else "version_conflict")
                self.assertTrue(all(m != "POST" for m, _ in self.calls))

    def test_other_original_owner_or_namespace_cannot_receive_this_version(self):
        self.detail["namespace"]["handle"] = "another_owner"
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "target_conflict"))
        self.assertTrue(all(m != "POST" for m, _ in self.calls))

    def test_missing_user_key_blocks_before_network(self):
        self.creds.write_text('{"version": 1, "orgs": {}}', encoding="utf-8")
        with mock.patch.object(publisher, "exchange", side_effect=AssertionError("network without key")):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "credentials_missing"))

    def test_saved_credential_host_or_owner_mismatch_stops_before_network(self):
        for field, value, reason in [("host", "https://other.invalid", "credentials_host"),
                                     ("handle", "another_owner", "owner_conflict")]:
            saved = {"host": "https://api.skillhub.cn", "token": TOKEN, "userId": 7, "handle": OWNER}
            saved[field] = value
            self.creds.write_text(json.dumps({"user": saved}), encoding="utf-8")
            with self.subTest(field=field), mock.patch.object(publisher, "exchange", side_effect=AssertionError("network before credential guard")):
                code, result = self.run_cli(submit=True)
                self.assertEqual((code, result["reason"]), (1, reason))

    def test_target_in_public_versions_blocks_even_when_latest_is_older(self):
        self.without_unverified_metadata()
        self.versions["versions"].append({"version": "1.17.0"})
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "version_conflict"))
        self.assertTrue(all(m != "POST" for m, _ in self.calls))

    def test_unknown_response_is_not_success_and_cannot_be_automatically_resubmitted(self):
        self.without_unverified_metadata()
        self.response = {"skillId": 123, "status": "pending_review", "message": TOKEN}
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
            self.assertEqual((code, result["status"]), (3, "submission_unknown"))
            self.assertTrue(self.receipt.exists())
            second, result2 = self.run_cli(submit=True)
        self.assertEqual((second, result2["reason"]), (1, "submission_receipt_exists"))
        self.assertEqual(sum(m == "POST" for m, _ in self.calls), 1)
        self.assertTrue(TOKEN not in self.receipt.read_text(encoding="utf-8"), "credential in receipt")

    def test_timeout_leaves_unknown_receipt_without_retry_or_secret_logging(self):
        self.without_unverified_metadata()
        self.post_error = urllib.error.URLError(TOKEN)
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["status"]), (3, "submission_unknown"))
        self.assertEqual(sum(m == "POST" for m, _ in self.calls), 1)
        self.assertTrue(TOKEN not in self.receipt.read_text(encoding="utf-8"), "credential in receipt")

    def test_5xx_and_409_leave_unknown_or_conflict_without_retry(self):
        self.without_unverified_metadata()
        for status, expected in [(500, "submission_unknown"), (409, "submission_conflict")]:
            with self.subTest(http=status):
                self.http_status = status
                self.response = {"message": TOKEN}
                self.calls.clear()
                with mock.patch.object(publisher, "exchange", self.fake_exchange):
                    code, result = self.run_cli(submit=True)
                self.assertEqual((code, result["status"]), (3, expected))
                self.assertEqual(sum(m == "POST" for m, _ in self.calls), 1)
                self.assertTrue(TOKEN not in self.receipt.read_text(encoding="utf-8"), "credential in receipt")
                self.receipt.unlink()  # Synthetic fixture only; production never clears uncertain attempts.

    def test_wrong_response_target_or_claimed_published_state_is_not_verified_success(self):
        self.without_unverified_metadata()
        for field, value in [("slug", "other-skill"), ("version", "1.18.0"), ("status", "published")]:
            with self.subTest(field=field):
                self.response = {"skillId": 123, "status": "pending_review", "slug": SLUG,
                                 "version": VERSION, "owner": {"handle": OWNER}}
                self.response[field] = value
                with mock.patch.object(publisher, "exchange", self.fake_exchange):
                    code, result = self.run_cli(submit=True)
                self.assertEqual((code, result["status"]), (3, "submission_unknown"))
                self.assertFalse(result.get("publicationVerified", False))
                self.receipt.unlink()

    def test_actual_snapshot_metadata_without_a_preservation_contract_blocks_submit(self):
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "optional_metadata_preservation_unverified"))
        self.assertTrue(all(m != "POST" for m, _ in self.calls))
        self.assertFalse(self.receipt.exists())

    def test_bearer_is_not_forwarded_to_a_cross_origin_redirect(self):
        requests = []

        def transport(handler, request):
            requests.append(request)
            from email.message import Message
            headers = Message()
            headers["Location"] = "https://other.invalid/collect"
            response = urllib.response.addinfourl(io.BytesIO(b'{}'), headers, request.full_url, 302)
            response.msg = "Found"
            return response

        with mock.patch.object(urllib.request.HTTPSHandler, "https_open", transport):
            status, _ = publisher.exchange("GET", "/api/v1/auth/me", TOKEN)
        self.assertEqual(status, 302)
        self.assertEqual([r.full_url for r in requests], ["https://api.skillhub.cn/api/v1/auth/me"])

    def test_argument_errors_do_not_echo_unexpected_secret_arguments(self):
        code, result = self.run_cli(extra=("--token", TOKEN))
        self.assertEqual((code, result["reason"]), (1, "arguments_invalid"))

    def test_known_browser_submission_blocks_before_credentials_even_if_public_version_is_old(self):
        with mock.patch.object(publisher, "load_user", side_effect=AssertionError("credential read for already submitted version")), \
                mock.patch.object(publisher, "exchange", side_effect=AssertionError("network for already submitted version")):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "target_already_submitted"))
        self.assertFalse(self.receipt.exists())


if __name__ == "__main__":
    unittest.main()
