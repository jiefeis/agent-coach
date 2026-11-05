import copy
from contextlib import redirect_stdout, redirect_stderr
from email import policy
from email.parser import BytesParser
import hashlib
import importlib.util
import io
import json
import os
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
OWNER, SLUG, VERSION = "user_0fdf85d4", "agent-coach", "1.18.0"
ICON = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/27205dc2-3c4b-4854-85b1-8902f05745a3.png"
SUBS = ["agent-framework", "agent-task-automation", "agent-workflow"]
ZH = "当前1.17公开中文摘要"
DELIVERED = "DELIVERED_VERIFIED_WITH_DEFERRED_PLATFORM_VALIDATION"


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="publish 合成-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.zip = self.root / "fixture.zip"  # Synthetic bytes only, never a real future product.
        self.meta = self.root / "release.json"
        self.creds = self.root / "credentials.json"
        self.pointer = self.root / "docs/evidence/当前试用候选.json"
        self.evidence = self.root / "docs/evidence/accepted/receipt.json"
        self.receipt_root = self.root / "docs/evidence/SkillHubCLI接入-20261105/提交回执"
        self.receipt = self.receipt_root / "agent-coach-1.18.0.submit.json"
        self.files = {n: ("fixture::" + n + "::原字节\r\n").encode() + b"\x00" for n in NAMES}
        self.metadata = {"owner": OWNER, "slug": SLUG, "version": VERSION,
                         "displayName": "Agent 搭建教练", "iconUrl": ICON, "category": "ai-agent",
                         "subCategories": list(SUBS), "summaryZh": ZH,
                         "summary": "existing summary", "changelog": "合成验证，不实际发布"}
        self.creds.write_text(json.dumps({"version": 1, "orgs": {}, "user": {
            "host": "https://api.skillhub.cn", "token": TOKEN, "userId": 7, "handle": OWNER,
            "loggedInAt": "2026-11-06T00:00:00Z"}}), encoding="utf-8")
        self.patch = mock.patch.multiple(publisher, WORKSPACE=self.root, CREDENTIALS=self.creds)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.approve(self.write_zip(self.files))
        self.auth = {"user": {"id": 7, "handle": OWNER, "role": "user"}}
        self.detail = {"slug": SLUG, "owner": {"handle": OWNER, "displayName": "Awake", "image": None},
                       "namespace": {"canonicalName": "@" + OWNER + "/" + SLUG, "handle": OWNER,
                                     "displayName": OWNER, "publicSlug": SLUG},
                       "latestVersion": {"version": "1.17.0", "changelog": "previous", "createdAt": 1},
                       "skill": {"slug": SLUG, "displayName": "Agent 搭建教练", "iconUrl": ICON,
                                 "summary": "existing summary", "summary_zh": ZH, "category": "ai-agent",
                                 "subCategories": [{"key": k, "name": "显示名"} for k in SUBS],
                                 "tags": {"latest": "1.17.0"}, "labels": {"requires_api_key": "false"},
                                 "source": "community", "sourceUrl": None, "ext": None,
                                 "overviewMd": "", "hasOverview": False, "verified": False}}
        self.response = {"skillId": 123, "status": "pending_review"}
        self.calls, self.post_error, self.http_status = [], None, 200
        self.versions = {"versions": [{"version": "1.17.0"}], "nextCursor": None}

    def write_zip(self, files):
        with zipfile.ZipFile(self.zip, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in files.items():
                item = zipfile.ZipInfo(name)
                item.filename = name  # Preserve raw unsafe separators on Windows.
                z.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED)
        raw = self.zip.read_bytes()
        return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "members": {n: {"bytes": len(v), "sha256": hashlib.sha256(v).hexdigest()} for n, v in files.items()}}

    def save_metadata(self):
        self.meta.parent.mkdir(parents=True, exist_ok=True)
        self.meta.write_text(json.dumps(self.metadata, ensure_ascii=False), encoding="utf-8")

    def approve(self, package=None, version=VERSION):
        if package is not None:
            self.metadata["package"] = copy.deepcopy(package)
        package = self.metadata["package"]
        self.metadata["version"] = version
        self.evidence.parent.mkdir(parents=True, exist_ok=True)
        self.evidence.write_text(json.dumps({"status": DELIVERED, "version": "v" + version,
                                            "packages": [{"path": str(self.zip), "bytes": package["bytes"],
                                                          "sha256": package["sha256"]}]}), encoding="utf-8")
        identity = {"path": str(self.evidence), "bytes": self.evidence.stat().st_size,
                    "sha256": hashlib.sha256(self.evidence.read_bytes()).hexdigest()}
        self.pointer.write_text(json.dumps({"status": DELIVERED, "version": "v" + version,
                                           "currentRequestComplete": True, "receipt": identity}), encoding="utf-8")
        self.metadata["acceptance"] = {**identity, "path": "docs/evidence/accepted/receipt.json"}
        self.save_metadata()

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
        message = BytesParser(policy=policy.default).parsebytes(("Content-Type: " + content_type + "\r\n\r\n").encode() + data)
        parts = list(message.iter_parts())
        self.assertEqual(len(parts), 25)
        payload = json.loads(parts[0].get_payload(decode=True))
        self.assertEqual(payload["iconUrl"], ICON)
        self.assertEqual(payload["version"], self.metadata["version"])
        self.assertEqual(payload["category"], "ai-agent")
        self.assertEqual(payload["subCategories"], SUBS)
        self.assertEqual(payload["summaryZh"], ZH)
        self.assertEqual(set(payload), {"slug", "version", "displayName", "iconUrl", "category",
                                       "subCategories", "summaryZh", "summary", "changelog"})
        self.assertEqual({p.get_filename(): p.get_payload(decode=True) for p in parts[1:]}, self.files)
        if self.post_error:
            raise self.post_error
        return self.http_status, copy.deepcopy(self.response)

    def test_default_preflight_reads_neither_credentials_nor_network_and_preserves_zip(self):
        raw, stamp = self.zip.read_bytes(), self.zip.stat().st_mtime_ns
        original_open = Path.open
        def guarded(path, *args, **kwargs):
            if Path(path) == self.creds:
                raise AssertionError("credential read during offline preflight")
            return original_open(path, *args, **kwargs)
        with mock.patch.object(Path, "open", guarded), mock.patch.object(publisher, "exchange", side_effect=AssertionError("network in preflight")):
            code, result = self.run_cli()
        self.assertEqual((code, result["status"], result["version"], result["fileCount"]), (0, "offline_validated", "1.18.0", 24))
        self.assertEqual((self.zip.read_bytes(), self.zip.stat().st_mtime_ns), (raw, stamp))
        self.assertFalse(self.receipt_root.exists())

    def test_future_versions_change_only_accepted_synthetic_data(self):
        for version in ["1.18.0", "1.19.0"]:
            self.approve(version=version)
            code, result = self.run_cli()
            self.assertEqual((code, result["version"], result["fileCount"]), (0, version, 24))

    def test_manifest_cannot_self_authorize_an_arbitrary_zip(self):
        forged = self.root / "docs/evidence/unapproved.json"
        forged.write_bytes(self.evidence.read_bytes())
        self.metadata["acceptance"] = {"path": "docs/evidence/unapproved.json", "bytes": forged.stat().st_size,
                                       "sha256": hashlib.sha256(forged.read_bytes()).hexdigest()}
        self.save_metadata()
        code, result = self.run_cli()
        self.assertEqual((code, result["reason"]), (1, "acceptance_binding"))

    def test_package_fingerprint_must_be_in_independently_bound_receipt(self):
        self.metadata["package"]["sha256"] = "a" * 64
        self.save_metadata()
        code, result = self.run_cli()
        self.assertEqual((code, result["reason"]), (1, "acceptance_package"))

    def test_changed_receipt_or_incomplete_pointer_does_not_grant_release(self):
        self.evidence.write_bytes(self.evidence.read_bytes() + b" ")
        self.assertEqual(self.run_cli()[1]["reason"], "acceptance_invalid")
        self.approve()
        value = json.loads(self.pointer.read_text(encoding="utf-8")); value["currentRequestComplete"] = False
        self.pointer.write_text(json.dumps(value), encoding="utf-8")
        self.assertEqual(self.run_cli()[1]["reason"], "acceptance_invalid")

    def test_missing_member_fingerprint_is_not_a_release_manifest(self):
        del self.metadata["package"]["members"]["SKILL.md"]
        self.save_metadata()
        code, result = self.run_cli()
        self.assertEqual((code, result["reason"]), (1, "release_package_invalid"))

    def test_wire_payload_contains_four_write_keys_and_24_original_files(self):
        release = publisher.read_release(self.meta)
        body, content_type = publisher.multipart(publisher.read_metadata(release), publisher.read_package(self.zip, release["package"]))
        m = BytesParser(policy=policy.default).parsebytes(("Content-Type: " + content_type + "\r\n\r\n").encode() + body)
        parts = list(m.iter_parts())
        self.assertEqual([p.get_param("name", header="content-disposition") for p in parts], ["payload"] + ["files"] * 24)
        self.assertEqual({p.get_filename(): p.get_payload(decode=True) for p in parts[1:]}, self.files)
        self.assertEqual(json.loads(parts[0].get_payload(decode=True)), {
            "slug": "agent-coach", "version": "1.18.0", "displayName": "Agent 搭建教练", "iconUrl": ICON,
            "category": "ai-agent", "subCategories": SUBS, "summaryZh": ZH,
            "summary": "existing summary", "changelog": "合成验证，不实际发布"})

    def test_hash_and_each_member_bytes_are_checked(self):
        self.zip.write_bytes(self.zip.read_bytes()[:-1] + b"x")
        self.assertEqual(self.run_cli()[1]["reason"], "zip_identity")
        changed = dict(self.files); changed["AGENTS.md"] = b"different"
        package = self.write_zip(changed); package["members"] = copy.deepcopy(self.metadata["package"]["members"])
        self.approve(package)
        self.assertEqual(self.run_cli()[1]["reason"], "member_identity")

    def test_unsafe_paths_still_fail_even_if_a_bad_zip_was_mistakenly_accepted(self):
        original_members = copy.deepcopy(self.metadata["package"]["members"])
        for name in ["../escape.md", "/absolute.md", "C:/escape.md", "a\\b.md", 'a"b.md', "a\r\nb.md", "a//b.md", "a./b.md"]:
            with self.subTest(path=name):
                files = dict(self.files); del files["README.md"]; files[name] = b"unsafe"
                package = self.write_zip(files); package["members"] = original_members
                self.approve(package)
                self.assertEqual(self.run_cli()[1]["reason"], "unsafe_member_path")

    def test_sidecar_cannot_become_a_25th_file(self):
        files = dict(self.files); files["release.json"] = b"{}"
        package = self.write_zip(files); package["members"] = self.metadata["package"]["members"]
        self.approve(package)
        self.assertEqual(self.run_cli()[1]["reason"], "member_count")

    def test_fixed_target_and_four_field_types_are_validated(self):
        original = copy.deepcopy(self.metadata)
        cases = [("owner", "another_owner", "metadata_owner"), ("slug", "another-skill", "metadata_slug"),
                 ("displayName", "another name", "metadata_displayName"), ("iconUrl", "http://other.invalid/icon", "metadata_iconUrl"),
                 ("category", [], "metadata_category"), ("subCategories", [{"key": "agent-workflow"}], "metadata_subCategories"),
                 ("subCategories", ["工作流编排"], "metadata_subCategories"), ("summaryZh", "", "metadata_summaryZh"),
                 ("tags", {"latest": "1.17.0"}, "metadata_tags")]
        for field, value, reason in cases:
            with self.subTest(field=field):
                self.metadata = copy.deepcopy(original); self.metadata[field] = value; self.save_metadata()
                code, result = self.run_cli()
                self.assertEqual((code, result["reason"]), (1, reason))

    def test_read_side_summary_key_or_self_claimed_authorization_is_not_writable_metadata(self):
        original = copy.deepcopy(self.metadata)
        for field in ["summary_zh", "authorized", "receiptDir"]:
            self.metadata = copy.deepcopy(original); self.metadata[field] = True; self.save_metadata()
            self.assertEqual(self.run_cli()[1]["reason"], "metadata_fields")

    def test_empty_optional_values_do_not_overwrite_fields_or_invent_license(self):
        payload = publisher.read_metadata(dict(self.metadata, license=None, homepage="", tags=[]))
        self.assertTrue(all(k not in payload for k in ["license", "homepage", "tags"]))

    def test_semver_validation_and_precedence_include_prerelease_and_build_metadata(self):
        ordered = ["1.18.0-alpha", "1.18.0-alpha.1", "1.18.0-beta", "1.18.0-beta.2", "1.18.0-beta.11", "1.18.0-rc.1", "1.18.0"]
        for left, right in zip(ordered, ordered[1:]):
            self.assertLess(publisher.version_key(left), publisher.version_key(right))
        self.assertEqual(publisher.version_key("1.18.0"), publisher.version_key("1.18.0+build.001"))
        self.assertEqual(publisher.local_version("v1.18"), "1.18.0")
        for invalid in ["01.18.0", "1.18", "1.18.0-01", "1.18.0 ", "1.18.0/escape"]:
            with self.subTest(value=invalid), self.assertRaises(publisher.Stop):
                publisher.version_key(invalid)

    def test_official_minimal_response_acknowledges_only_pending_review(self):
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["status"]), (0, "submitted_pending_review"))
        self.assertEqual(self.calls, [("GET", "/api/v1/auth/me"), ("GET", "/api/v1/skills/agent-coach"),
                                     ("GET", "/api/v1/skills/agent-coach/versions"), ("POST", "/api/v1/community/skills/publish")])
        self.assertIs(result["publicationVerified"], False)
        self.assertTrue(self.receipt.exists())

    def test_matching_optional_echo_and_public_url_are_allowed(self):
        self.response.update(owner={"handle": OWNER, "id": 7}, slug=SLUG, version=VERSION,
                             publicUrl="https://skillhub.cn/skills/user_0fdf85d4/agent-coach")
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["status"]), (0, "submitted_pending_review"))

    def test_safe_opaque_skill_id_does_not_require_optional_echoes(self):
        self.response = {"skillId": "skill-id_123", "status": "pending_review"}
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["status"], result["skillId"]),
                         (0, "submitted_pending_review", "skill-id_123"))
        self.assertIs(result["publicationVerified"], False)

    def test_wrong_live_owner_never_reaches_publish(self):
        self.auth["user"]["handle"] = "another_owner"
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
        self.assertEqual((code, result["reason"]), (1, "owner_conflict"))
        self.assertTrue(all(m != "POST" for m, _ in self.calls))

    def test_changed_original_fields_or_existing_public_target_block_publish(self):
        original = copy.deepcopy(self.detail)
        cases = [("iconUrl", "https://other.invalid/icon.png", "icon_conflict"),
                 ("category", "other-category", "metadata_conflict_category"),
                 ("subCategories", [{"key": "other-key"}], "metadata_conflict_subCategories"),
                 ("summary_zh", "过时的1.16中文摘要", "metadata_conflict_summaryZh")]
        for field, value, reason in cases:
            with self.subTest(field=field):
                self.detail = copy.deepcopy(original); self.detail["skill"][field] = value
                with mock.patch.object(publisher, "exchange", self.fake_exchange):
                    code, result = self.run_cli(submit=True)
                self.assertEqual((code, result["reason"]), (1, reason))
                self.assertTrue(all(m != "POST" for m, _ in self.calls))
        self.detail = original; self.detail["latestVersion"]["version"] = VERSION
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            self.assertEqual(self.run_cli(submit=True)[1]["reason"], "version_conflict")

    def test_original_missing_metadata_or_other_namespace_blocks(self):
        self.detail["skill"]["summary_zh"] = None
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            self.assertEqual(self.run_cli(submit=True)[1]["reason"], "original_metadata_missing")
        self.detail["skill"]["summary_zh"] = ZH; self.detail["namespace"]["handle"] = "another_owner"
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            self.assertEqual(self.run_cli(submit=True)[1]["reason"], "target_conflict")

    def test_missing_user_key_blocks_before_network(self):
        self.creds.write_text('{"version": 1, "orgs": {}}', encoding="utf-8")
        with mock.patch.object(publisher, "exchange", side_effect=AssertionError("network without key")):
            self.assertEqual(self.run_cli(submit=True)[1]["reason"], "credentials_missing")

    def test_saved_credential_host_or_owner_mismatch_stops_before_network(self):
        for field, value, reason in [("host", "https://other.invalid", "credentials_host"), ("handle", "another_owner", "owner_conflict")]:
            saved = {"host": "https://api.skillhub.cn", "token": TOKEN, "userId": 7, "handle": OWNER}; saved[field] = value
            self.creds.write_text(json.dumps({"user": saved}), encoding="utf-8")
            with self.subTest(field=field), mock.patch.object(publisher, "exchange", side_effect=AssertionError("network before credential guard")):
                self.assertEqual(self.run_cli(submit=True)[1]["reason"], reason)

    def test_public_versions_at_or_above_target_block_even_when_latest_is_older(self):
        for version in ["1.18.0", "1.19.0"]:
            self.versions["versions"] = [{"version": "1.17.0"}, {"version": version}]
            with mock.patch.object(publisher, "exchange", self.fake_exchange):
                self.assertEqual(self.run_cli(submit=True)[1]["reason"], "version_conflict")
            self.assertTrue(all(m != "POST" for m, _ in self.calls))

    def test_unknown_response_cannot_be_automatically_resubmitted(self):
        self.response = {"status": "pending_review", "message": TOKEN}
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            code, result = self.run_cli(submit=True)
            self.assertEqual((code, result["status"]), (3, "submission_unknown"))
            second, result2 = self.run_cli(submit=True)
        self.assertEqual((second, result2["reason"]), (1, "submission_receipt_exists"))
        self.assertEqual(sum(m == "POST" for m, _ in self.calls), 1)
        self.assertTrue(TOKEN not in self.receipt.read_text(encoding="utf-8"), "credential in receipt")

    def test_receipt_location_does_not_follow_metadata_directory_or_cwd(self):
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            self.assertEqual(self.run_cli(submit=True)[0], 0)
        moved = self.root / "elsewhere/release.json"; moved.parent.mkdir(); moved.write_bytes(self.meta.read_bytes()); self.meta = moved
        old = Path.cwd()
        try:
            os.chdir(moved.parent)
            with mock.patch.object(publisher, "load_user", side_effect=AssertionError("key read after existing receipt")), \
                    mock.patch.object(publisher, "exchange", side_effect=AssertionError("network after existing receipt")):
                code, result = self.run_cli(submit=True)
        finally:
            os.chdir(old)
        self.assertEqual((code, result["reason"]), (1, "submission_receipt_exists"))
        self.assertTrue(self.receipt.exists())
        self.assertFalse((moved.parent / self.receipt.name).exists())

    def test_build_metadata_does_not_create_another_attempt_slot(self):
        self.approve(version="1.18.0+first")
        with mock.patch.object(publisher, "exchange", self.fake_exchange):
            self.assertEqual(self.run_cli(submit=True)[0], 0)
        self.approve(version="1.18.0+second")
        with mock.patch.object(publisher, "exchange", side_effect=AssertionError("second build must not submit")):
            self.assertEqual(self.run_cli(submit=True)[1]["reason"], "submission_receipt_exists")

    def test_timeout_5xx_and_409_leave_unknown_or_conflict_without_retry(self):
        for kind, expected in [("timeout", "submission_unknown"), (500, "submission_unknown"), (409, "submission_conflict")]:
            with self.subTest(kind=kind):
                self.http_status = kind if isinstance(kind, int) else 200
                self.post_error = urllib.error.URLError(TOKEN) if kind == "timeout" else None
                self.response = {"message": TOKEN}; self.calls.clear()
                with mock.patch.object(publisher, "exchange", self.fake_exchange):
                    code, result = self.run_cli(submit=True)
                self.assertEqual((code, result["status"]), (3, expected))
                self.assertEqual(sum(m == "POST" for m, _ in self.calls), 1)
                self.assertTrue(TOKEN not in self.receipt.read_text(encoding="utf-8"), "credential in receipt")
                self.receipt.unlink()  # Synthetic attempt only; production never clears uncertain attempts.

    def test_optional_echo_conflicts_unknown_states_or_secret_ids_are_not_acknowledged(self):
        cases = [("slug", "other-skill"), ("version", "1.19.0"), ("owner", {"handle": "other"}),
                 ("owner", {"handle": OWNER, "id": 8}), ("publicUrl", "https://other.invalid/agent-coach"),
                 ("skillId", TOKEN), ("skillId", True), ("skillId", ""), ("status", "published")]
        for field, value in cases:
            with self.subTest(field=field):
                self.response = {"skillId": 123, "status": "pending_review"}; self.response[field] = value
                with mock.patch.object(publisher, "exchange", self.fake_exchange):
                    code, result = self.run_cli(submit=True)
                self.assertEqual((code, result["status"]), (3, "submission_unknown"))
                self.assertFalse(result["publicationVerified"])
                self.assertTrue(TOKEN not in self.receipt.read_text(encoding="utf-8"), "credential in receipt")
                self.receipt.unlink()

    def test_bearer_is_not_forwarded_to_a_cross_origin_redirect(self):
        requests = []
        def transport(handler, request):
            requests.append(request)
            from email.message import Message
            headers = Message(); headers["Location"] = "https://other.invalid/collect"
            response = urllib.response.addinfourl(io.BytesIO(b'{}'), headers, request.full_url, 302)
            response.msg = "Found"
            return response
        with mock.patch.object(urllib.request.HTTPSHandler, "https_open", transport):
            status, _ = publisher.exchange("GET", "/api/v1/auth/me", TOKEN)
        self.assertEqual(status, 302)
        self.assertEqual([r.full_url for r in requests], ["https://api.skillhub.cn/api/v1/auth/me"])

    def test_argument_errors_do_not_echo_unexpected_secret_arguments(self):
        for option in ["--token", "--force", "--receipt-dir"]:
            code, result = self.run_cli(extra=(option, TOKEN))
            self.assertEqual((code, result["reason"]), (1, "arguments_invalid"))

    def test_known_117_never_reads_credentials_or_network_even_with_rewritten_manifest(self):
        for version in ["1.17.0", "1.17.0+repost"]:
            self.approve(version=version)
            with mock.patch.object(publisher, "load_user", side_effect=AssertionError("credential read for already published version")), \
                    mock.patch.object(publisher, "exchange", side_effect=AssertionError("network for already published version")):
                code, result = self.run_cli(submit=True)
            self.assertEqual((code, result["reason"]), (1, "target_already_submitted"))
        self.metadata["version"] = "1.18.0"; self.save_metadata()
        with mock.patch.object(publisher, "load_user", side_effect=AssertionError("credential for forged acceptance")), \
                mock.patch.object(publisher, "exchange", side_effect=AssertionError("network for forged acceptance")):
            code, _ = self.run_cli(submit=True)
        self.assertEqual(code, 1)
        self.assertFalse(self.receipt_root.exists())


if __name__ == "__main__":
    unittest.main()
