from __future__ import annotations

import importlib.util
import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "staging_place_collect", REPO / "tools" / "staging-place-collect.py"
)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class Session:
    def __init__(self):
        self.trust_env = True
        self.closed = False

    def close(self):
        self.closed = True


class Response:
    def __init__(self, status_code, headers=None):
        self.status_code = status_code
        self.headers = headers or {}


class RetryAfterSession(Session):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def get(self, *args, **kwargs):
        self.calls += 1
        return Response(429, {"Retry-After": "301"})


class TestGlobalPacer:
    def __init__(self, requests_per_second, *, clock=lambda: 0.0, sleep=lambda _: None):
        self._gap = 1.0 / requests_per_second
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next = 0.0
        self._cooldown = 0.0
        self._stopped = False
        self.reservations = []

    def take(self):
        while True:
            with self._lock:
                if self._stopped:
                    raise RuntimeError("stopped")
                now = self._clock()
                at = max(now, self._next, self._cooldown)
                self._next = at + self._gap
                self.reservations.append(at)
            if at > now:
                self._sleep(at - now)
            with self._lock:
                if self._clock() >= self._cooldown:
                    return

    def defer(self, seconds):
        with self._lock:
            self._cooldown = max(self._cooldown, self._clock() + seconds)
            self._next = max(self._next, self._cooldown)

    def stop(self):
        with self._lock:
            self._stopped = True


class SurfProducer:
    MAX_HOURS = 72

    def __init__(self):
        self.collected_session = None
        self.finalized_stage = None

    def load_catalog(self, path):
        return {"version": "pilot", "spots": [{"id": f"s{i}"} for i in range(49)]}

    def collect_direct(self, catalog, stage_path, run_id, hours, session):
        self.collected_session = session
        initialized = datetime.strptime(run_id, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        samples = [
            {"time": int((initialized + timedelta(hours=i)).timestamp() * 1000),
             "waveHeight": 1.25, "period": 9.5, "waveDirection": 271.0,
             "windSpeed": 4.75, "windDirection": 182.0}
            for i in range(73)
        ]
        stage = {"schemaVersion": 1, "catalogVersion": "pilot", "runId": run_id,
                 "initializedAt": initialized.strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "freshUntil": (initialized + timedelta(hours=18)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "cadenceSeconds": 3600,
                 "spots": [{"spotId": f"s{i}", "sampling": {"wet": True, "distanceKm": 1},
                            "samples": samples} for i in range(49)]}
        stage_path.write_text(json.dumps(stage))
        return stage

    def validate_stage(self, stage, catalog):
        assert stage["catalogVersion"] == catalog["version"]

    def stage_matches(self, path, catalog, run_id):
        return json.loads(path.read_text())["runId"] == run_id

    def finalize(self, stage_path, catalog, output, release_id):
        self.finalized_stage = json.loads(stage_path.read_text())
        output.mkdir()
        index = {"releaseId": release_id, "source": {
            "runId": self.finalized_stage["runId"],
            "initializedAt": self.finalized_stage["initializedAt"],
            "freshUntil": self.finalized_stage["freshUntil"],
        }, "times": [row["time"] for row in self.finalized_stage["spots"][0]["samples"]],
            "spots": [{"spotId": row["spotId"]} for row in self.finalized_stage["spots"]]}
        (output / "index.json").write_text(json.dumps(index))
        return index


class TideProducer:
    CHECKPOINT_SCHEMA_VERSION = 1
    LOOKBACK_DAYS = 1
    FORECAST_DAYS = 7
    RIGHT_BRACKET_DAYS = 1
    MAX_REQUESTS_PER_SECOND = 4.0
    _GlobalPacer = TestGlobalPacer

    def __init__(self):
        self.manifest = None
        self.bake_args = None
        self._GLOBAL_PACER = self._GlobalPacer(self.MAX_REQUESTS_PER_SECOND)

    def _session(self):
        return Session()

    def fetch_stations(self, session):
        assert session.trust_env is False
        return [{"id": str(i), "type": "R"} for i in range(1256)]

    def _canonical_roster(self, stations, kinds):
        assert kinds == ("R",)
        return sorted(stations, key=lambda row: int(row["id"]))

    def _iso(self, value):
        return value.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _atomic_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        self.manifest = json.loads(path.read_text())

    def _checkpoint_manifest(self, checkpoint):
        return json.loads((checkpoint / "manifest.json").read_text())

    def bake_v2(self, session, stations, output, legacy, **kwargs):
        self.bake_args = (session, stations, output, legacy, kwargs)
        assert kwargs["staging_partial"] is True
        assert kwargs["min_available_stations"] == 1251
        assert self._checkpoint_manifest(kwargs["checkpoint_dir"])["retrievedAt"] == self._iso(kwargs["now"])
        output.mkdir(parents=True)
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("{}")
        available = [{"id": str(i)} for i in range(1251)]
        catalog = {"datasetId": "noaa-coops-" + kwargs["now"].strftime("%Y%m%dT%H%M%SZ"),
                   "retrievedAt": self._iso(kwargs["now"]), "stations": available,
                   "availability": {"requestedCount": 1256, "availableCount": 1251, "unavailableCount": 5}}
        (output / "catalog.json").write_text(json.dumps(catalog))
        return catalog, 5


class FailingTideProducer(TideProducer):
    def __init__(self):
        super().__init__()
        self.bake_calls = 0

    def bake_v2(self, *args, **kwargs):
        self.bake_calls += 1
        raise RuntimeError("provider body must not become success")


class TimestampChangingTideProducer(TideProducer):
    def __init__(self):
        super().__init__()
        self.bake_calls = 0

    def bake_v2(self, *args, **kwargs):
        self.bake_calls += 1
        catalog, failed = super().bake_v2(*args, **kwargs)
        path = kwargs["checkpoint_dir"] / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["retrievedAt"] = "2000-01-01T00:00:00Z"
        path.write_text(json.dumps(manifest))
        return catalog, failed


class InvalidCatalogTideProducer(TideProducer):
    def __init__(self):
        super().__init__()
        self.bake_calls = 0

    def bake_v2(self, *args, **kwargs):
        self.bake_calls += 1
        catalog, failed = super().bake_v2(*args, **kwargs)
        catalog["retrievedAt"] = "2000-01-01T00:00:00Z"
        return catalog, failed


class ResumableTideProducer(TideProducer):
    def __init__(self, fail_second=False, tamper_manifest=False):
        super().__init__()
        self.fail_second = fail_second
        self.tamper_manifest = tamper_manifest
        self.bake_calls = 0
        self.sessions = []
        self.manifest_hashes = []
        self.cached_product = None

    def bake_v2(self, session, stations, output, legacy, **kwargs):
        self.bake_calls += 1
        self.sessions.append(session)
        manifest_path = kwargs["checkpoint_dir"] / "manifest.json"
        self.manifest_hashes.append(hashlib.sha256(manifest_path.read_bytes()).hexdigest())
        cached = kwargs["checkpoint_dir"] / "products" / "1" / "hilo.json"
        if self.bake_calls == 1:
            cached.parent.mkdir(parents=True)
            cached.write_text('{"cached":true}')
            self.cached_product = cached.read_bytes()
            if self.tamper_manifest:
                manifest_path.write_bytes(manifest_path.read_bytes() + b"\n")
            raise RuntimeError(
                "Staging tide minimum not met (1169 available, 1251 required); previous catalog preserved"
            )
        assert cached.read_bytes() == self.cached_product
        if self.fail_second:
            raise RuntimeError(
                "Staging tide minimum not met (1249 available, 1251 required); previous catalog preserved"
            )
        return super().bake_v2(session, stations, output, legacy, **kwargs)


class WrongTypeMinimumTideProducer(FailingTideProducer):
    def bake_v2(self, *args, **kwargs):
        self.bake_calls += 1
        raise ValueError(
            "Staging tide minimum not met (1169 available, 1251 required); previous catalog preserved"
        )


class PacerStoppedMinimumTideProducer(ResumableTideProducer):
    MAX_RETRY_AFTER_S = 300.0

    def __init__(self):
        super().__init__(fail_second=True)

    def bake_v2(self, session, *args, **kwargs):
        if self.bake_calls == 0:
            session.get("https://private.invalid/path?token=DO-NOT-PRINT", timeout=30)
            self._GLOBAL_PACER._stopped = True
        return super().bake_v2(session, *args, **kwargs)


class PlaceCollector(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_retry_after_telemetry_matches_pinned_overlong_numeric_contract(self):
        self.assertTrue(collector._RequestTelemetry._overlong_retry_after("301", 300))
        self.assertTrue(collector._RequestTelemetry._overlong_retry_after("9" * 129, 300))
        self.assertFalse(collector._RequestTelemetry._overlong_retry_after("x" * 129, 300))

    def test_tide_rate_tightening_preserves_existing_pacer_identity_and_state(self):
        producer = TideProducer()
        pacer = producer._GLOBAL_PACER
        pacer._next, pacer._cooldown = 7.0, 9.0
        lock, clock, sleep = pacer._lock, pacer._clock, pacer._sleep
        collector._configure_tide_pacer(producer, 2.0)
        self.assertIs(producer._GLOBAL_PACER, pacer)
        self.assertIs(pacer._lock, lock)
        self.assertIs(pacer._clock, clock)
        self.assertIs(pacer._sleep, sleep)
        self.assertEqual((pacer._next, pacer._cooldown, pacer._stopped), (7.0, 9.0, False))
        self.assertEqual(pacer._gap, 0.5)
        pacer._gap = 0.75
        collector._configure_tide_pacer(producer, 2.0)
        self.assertEqual(pacer._gap, 0.75)

    def test_tide_rate_tightening_shared_concurrency_and_cooldown_recheck(self):
        class Clock:
            value = 0.0
            lock = threading.Lock()

            def now(self):
                with self.lock:
                    return self.value

            def advance(self, seconds):
                with self.lock:
                    self.value += seconds

        clock = Clock()
        producer = TideProducer()
        producer._GLOBAL_PACER = producer._GlobalPacer(4.0, clock=clock.now, sleep=clock.advance)
        pacer = producer._GLOBAL_PACER
        collector._configure_tide_pacer(producer, 2.0)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: pacer.take(), range(4)))
        self.assertEqual(pacer.reservations, [0.0, 0.5, 1.0, 1.5])

        waiting, release = threading.Event(), threading.Event()
        sleeps = []

        def controlled_sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 1:
                waiting.set()
                release.wait(timeout=2)
            clock.advance(seconds)

        clock.value = 0.0
        producer._GLOBAL_PACER = producer._GlobalPacer(4.0, clock=clock.now, sleep=controlled_sleep)
        pacer = producer._GLOBAL_PACER
        collector._configure_tide_pacer(producer, 2.0)
        pacer.take()
        worker = threading.Thread(target=pacer.take)
        worker.start()
        self.assertTrue(waiting.wait(timeout=2))
        pacer.defer(2.0)
        release.set()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(pacer.reservations, [0.0, 0.5, 2.0])
        self.assertEqual(sleeps, [0.5, 1.5])

    def test_tide_rate_tightening_refuses_stopped_or_unreviewed_pacer_before_session(self):
        for index, (producer, rate) in enumerate(((TideProducer(), 2.0), (TideProducer(), 2.0),
                                                   (TideProducer(), 4.0), (TideProducer(), 2.0))):
            pacer = producer._GLOBAL_PACER
            pacer._next, pacer._cooldown = 7.0, 9.0
            if index == 0:
                pacer._stopped = True
            else:
                if index == 1:
                    producer.MAX_REQUESTS_PER_SECOND = 3.0
                elif index == 3:
                    producer._GlobalPacer = type("ForeignPacer", (), {})
            before = (pacer._gap, pacer._next, pacer._cooldown, pacer._stopped, id(pacer))
            session_calls = []
            with self.subTest(index=index), self.assertRaises(collector.CollectionFailure):
                collector.collect_tides(self.base / f"rate-{index}", producer, clock=lambda: datetime.now(timezone.utc),
                    session_factory=lambda: session_calls.append(True), requests_per_second=rate)
            self.assertEqual(session_calls, [])
            self.assertEqual((pacer._gap, pacer._next, pacer._cooldown, pacer._stopped, id(pacer)), before)

    def test_surf_selects_exact_aged_cycle_and_preserves_stage_values_and_times(self):
        start = datetime(2026, 9, 10, 18, 30, tzinfo=timezone.utc)
        producer = SurfProducer()
        session = Session()
        moments = iter([start, start + timedelta(minutes=10)])
        result = collector.collect(self.source, self.base / "run", "surf", env={},
            clock=lambda: next(moments), modules={"surf": producer}, session_factory=lambda: session)
        self.assertEqual(producer.finalized_stage["runId"], "2026091012")
        self.assertEqual(producer.finalized_stage["spots"][0]["samples"][0]["waveHeight"], 1.25)
        self.assertEqual(producer.finalized_stage["spots"][0]["samples"][-1]["period"], 9.5)
        self.assertTrue(result["identity"].startswith("surf-2026091012-"))
        self.assertFalse(session.trust_env)
        self.assertTrue(session.closed)
        self.assertEqual((self.base / "run" / "checkpoint" / "stage.json").is_file(), True)
        self.assertEqual((self.base / "run" / "candidate" / "index.json").is_file(), True)

    def test_surf_refuses_post_collection_candidate_with_less_than_six_hours_left(self):
        start = datetime(2026, 9, 10, 17, 59, tzinfo=timezone.utc)
        producer = SurfProducer()
        moments = iter([start, start + timedelta(minutes=2)])
        with self.assertRaises(collector.CollectionRefused):
            collector.collect(self.source, self.base / "run", "surf", env={},
                clock=lambda: next(moments), modules={"surf": producer}, session_factory=Session)

    def test_tides_freeze_new_official_roster_once_then_use_partial_policy(self):
        now = datetime(2026, 9, 10, 17, 19, 59, 987000, tzinfo=timezone.utc)
        producer = TideProducer()
        result = collector.collect(self.source, self.base / "run", "tides", env={},
            clock=lambda: now, modules={"tides": producer})
        manifest = json.loads((self.base / "run/checkpoint/manifest.json").read_text())
        self.assertEqual(manifest["retrievedAt"], "2026-09-10T17:19:59Z")
        self.assertEqual(manifest["beginDate"], "2026-09-09")
        self.assertEqual(manifest["endDate"], "2026-09-18")
        self.assertEqual(len(manifest["stations"]), 1256)
        self.assertEqual(producer.bake_args[-1]["now"], datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc))
        self.assertEqual(result["availableStationCount"], 1251)
        self.assertFalse(producer.bake_args[0].trust_env)
        self.assertTrue(producer.bake_args[0].closed)

    def test_tides_resume_exact_minimum_failure_once_using_same_frozen_checkpoint(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        producer = ResumableTideProducer()
        session = Session()
        result = collector.collect(self.source, self.base / "run", "tides", env={},
            clock=lambda: now, modules={"tides": producer}, session_factory=lambda: session)
        self.assertEqual(producer.bake_calls, 2)
        self.assertIs(producer.sessions[0], producer.sessions[1])
        self.assertEqual(producer.manifest_hashes[0], producer.manifest_hashes[1])
        self.assertEqual(result["resumeAttempts"], 1)
        self.assertEqual(result["firstPassAvailableStationCount"], 1169)
        self.assertEqual(result["availableStationCount"], 1251)
        self.assertTrue(session.closed)

    def test_tides_do_not_retry_nonminimum_errors_or_matching_text_of_wrong_type(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        for index, producer in enumerate((FailingTideProducer(), WrongTypeMinimumTideProducer(),
                                          InvalidCatalogTideProducer())):
            session = Session()
            with self.subTest(producer=type(producer).__name__), self.assertRaises(Exception):
                collector.collect(self.source, self.base / f"nonminimum-{index}", "tides", env={},
                    clock=lambda: now, modules={"tides": producer}, session_factory=lambda: session)
            self.assertEqual(producer.bake_calls, 1)
            self.assertTrue(session.closed)

    def test_tides_second_minimum_failure_gets_no_third_attempt(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        producer = ResumableTideProducer(fail_second=True)
        session = Session()
        with self.assertRaises(collector.CollectionFailure) as caught:
            collector.collect(self.source, self.base / "run", "tides", env={},
                clock=lambda: now, modules={"tides": producer}, session_factory=lambda: session)
        self.assertEqual(producer.bake_calls, 2)
        self.assertTrue(session.closed)
        receipt = collector.failure_receipt("tides", caught.exception)
        self.assertEqual(receipt["phase"], "fetch")
        self.assertEqual(receipt["class"], "minimum-availability")
        self.assertEqual(receipt["rosterStationCount"], 1256)
        self.assertEqual(receipt["availableStationCount"], 1249)
        self.assertEqual(receipt["requiredStationCount"], 1251)
        self.assertEqual(receipt["resumeAttempts"], 1)
        self.assertEqual(receipt["firstPassAvailableStationCount"], 1169)

    def test_tides_failure_reports_only_aggregate_http_and_stopped_pacer_state(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        producer = PacerStoppedMinimumTideProducer()
        session = RetryAfterSession()
        with self.assertRaises(collector.CollectionFailure) as caught:
            collector.collect(self.source, self.base / "run", "tides", env={},
                clock=lambda: now, modules={"tides": producer}, session_factory=lambda: session)
        receipt = collector.failure_receipt("tides", caught.exception)
        self.assertEqual(session.calls, 1)
        self.assertEqual(producer.bake_calls, 1)
        self.assertEqual(receipt["class"], "provider-cooldown")
        self.assertEqual(receipt["availableStationCount"], 1169)
        self.assertEqual(receipt["requiredStationCount"], 1251)
        self.assertEqual(receipt["resumeAttempts"], 0)
        self.assertEqual(receipt["requestCounts"], {
            "http2xx": 0, "http403": 0, "http429": 1, "http5xx": 0, "httpOther": 0,
            "timeouts": 0, "overlongRetryAfter": 1, "pacerStopped": True,
        })
        self.assertEqual(receipt["firstPassRequestCounts"], receipt["requestCounts"])
        self.assertNotIn("private.invalid", json.dumps(receipt))
        self.assertNotIn("DO-NOT-PRINT", json.dumps(receipt))

    def test_tides_manifest_byte_tamper_blocks_resume(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        producer = ResumableTideProducer(tamper_manifest=True)
        session = Session()
        with self.assertRaises(Exception):
            collector.collect(self.source, self.base / "run", "tides", env={},
                clock=lambda: now, modules={"tides": producer}, session_factory=lambda: session)
        self.assertEqual(producer.bake_calls, 1)
        self.assertTrue(session.closed)

    def test_tides_do_not_accept_arbitrary_failure_or_rewritten_checkpoint_clock(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        for index, producer in enumerate((FailingTideProducer(), TimestampChangingTideProducer())):
            with self.subTest(producer=type(producer).__name__), self.assertRaises(Exception):
                collector.collect(self.source, self.base / f"run-{index}", "tides", env={},
                    clock=lambda: now, modules={"tides": producer})
            self.assertEqual(producer.bake_calls, 1)

    def test_refuses_existing_or_checkout_nested_root_and_publication_credentials(self):
        existing = self.base / "existing"
        existing.mkdir()
        with self.assertRaises(collector.CollectionRefused):
            collector.collect(self.source, existing, "surf", env={}, modules={"surf": SurfProducer()})
        with self.assertRaises(collector.CollectionRefused):
            collector.collect(self.source, self.source / "run", "surf", env={}, modules={"surf": SurfProducer()})
        with self.assertRaises(collector.CollectionRefused):
            collector.collect(self.source, self.base / "run", "tides", env={"STAGING_R2_WRITE_SECRET_ACCESS_KEY": "private"}, modules={"tides": TideProducer()})
        self.assertFalse((self.base / "run").exists())

    def test_cli_failure_is_fixed_and_does_not_echo_private_source_or_environment(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(REPO / "tools/staging-place-collect.py"),
            "--source", "/private/source-name", "--root", str(self.base / "run"), "--family", "surf",
            "--tide-requests-per-second", "2"],
            env={"PATH": "/usr/bin:/bin", "STAGING_R2_WRITE_SECRET_ACCESS_KEY": "DO-NOT-PRINT"},
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        receipt = json.loads(result.stderr)
        self.assertEqual(receipt, {"schemaVersion": 1, "kind": "staging-place-collection", "status": "failed",
            "family": "surf", "phase": "setup", "class": "environment"})
        self.assertNotIn("private/source-name", result.stdout + result.stderr)
        self.assertNotIn("DO-NOT-PRINT", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
