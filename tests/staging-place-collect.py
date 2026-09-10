from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
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

    def __init__(self):
        self.manifest = None
        self.bake_args = None

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
    def bake_v2(self, *args, **kwargs):
        raise RuntimeError("provider body must not become success")


class TimestampChangingTideProducer(TideProducer):
    def bake_v2(self, *args, **kwargs):
        catalog, failed = super().bake_v2(*args, **kwargs)
        path = kwargs["checkpoint_dir"] / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["retrievedAt"] = "2000-01-01T00:00:00Z"
        path.write_text(json.dumps(manifest))
        return catalog, failed


class PlaceCollector(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()

    def tearDown(self):
        self.temp.cleanup()

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

    def test_tides_do_not_accept_arbitrary_failure_or_rewritten_checkpoint_clock(self):
        now = datetime(2026, 9, 10, 17, 19, 59, tzinfo=timezone.utc)
        for index, producer in enumerate((FailingTideProducer(), TimestampChangingTideProducer())):
            with self.subTest(producer=type(producer).__name__), self.assertRaises(Exception):
                collector.collect(self.source, self.base / f"run-{index}", "tides", env={},
                    clock=lambda: now, modules={"tides": producer})

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
        result = subprocess.run([sys.executable, str(REPO / "tools/staging-place-collect.py"),
            "--source", "/private/source-name", "--root", str(self.base / "run"), "--family", "surf"],
            env={"PATH": "/usr/bin:/bin", "STAGING_R2_WRITE_SECRET_ACCESS_KEY": "DO-NOT-PRINT"},
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "staging place collection refused\n")
        self.assertNotIn("private/source-name", result.stdout + result.stderr)
        self.assertNotIn("DO-NOT-PRINT", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
