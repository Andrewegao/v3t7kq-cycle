from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('five_feed',Path(__file__).parents[1]/'tools/five-feed-collect.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
NOW=datetime(2026,10,6,16,tzinfo=timezone.utc);START=NOW-timedelta(minutes=20)
def iso(time):return time.isoformat().replace('+00:00','Z')
def write(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
def station(age=10):return dict(id='real-id',icao='REAL',lat=0,lon=0,src='ndbc',obs_time=iso(NOW-timedelta(minutes=age)))
def pack(family,root):
    row=station();doc=dict(baked_at=iso(NOW-timedelta(minutes=10)),source='genuine source',stations=[row])
    if family=='openaq':
        row.update(lic='Commercial license',v={'pm25':[12,10]});doc.update(freshness={'max_age_min':180},license={'allowed':['Commercial license']})
    write(root/r.FAMILIES[family][1],doc);return doc
def fires(root):
    row=dict(lat=0,lon=0,frp=2,sat='NOAA-20',acq=iso(NOW-timedelta(hours=1)))
    envelope=dict(baked_at=iso(NOW-timedelta(minutes=10)),source='NOAA-20',missing_feeds=['Suomi NPP'])
    write(root/'fires.json',{**envelope,'fires':[row]})
    write(root/'overview.json',{**envelope,'fires':[{**row,'count':1}]})
    write(root/'tiles/18_9.json',{'baked_at':envelope['baked_at'],'fires':[row]})
    write(root/'index.json',{**envelope,'schemaVersion':1,'cell_deg':10,'overview':'overview.json','tiles':'tiles/',
          'total':1,'detected_total':1,'overview_rows':1,'cells':{'18_9':1}})

class AdmissionTests(unittest.TestCase):
    def test_each_family_needs_new_nonempty_real_current_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for family in ['metar','synop','buoys','openaq']:
                p=root/family;doc=pack(family,p)
                self.assertEqual(r.validate_family(family,p,START,NOW)['currentRecords'],1)
                doc['baked_at']=iso(START-timedelta(seconds=1));write(p/r.FAMILIES[family][1],doc)
                with self.assertRaisesRegex(ValueError,'old-or-future'):r.validate_family(family,p,START,NOW)
                doc=pack(family,p);doc['stations']=[];write(p/r.FAMILIES[family][1],doc)
                with self.assertRaisesRegex(ValueError,'nonempty'):r.validate_family(family,p,START,NOW)
                doc=pack(family,p);doc['stations'][0]['obs_time']=iso(NOW-timedelta(days=1));write(p/r.FAMILIES[family][1],doc)
                with self.assertRaisesRegex(ValueError,'no-current'):r.validate_family(family,p,START,NOW)
    def test_honest_stale_tail_is_retained_but_not_counted_as_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);doc=pack('metar',p);doc['stations'].append(station(age=240));write(p/'metar.json',doc)
            actual=r.validate_family('metar',p,START,NOW);self.assertEqual(actual['rows'],2);self.assertEqual(actual['currentRecords'],1)
            p=Path(tmp)/'buoys';doc=pack('buoys',p);doc['stations'].append(station(age=95));write(p/'stations.json',doc)
            self.assertEqual(r.validate_family('buoys',p,START,NOW)['currentRecords'],1)
    def test_openaq_encoded_reading_age_adds_elapsed_time_and_license_is_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);doc=pack('openaq',p);doc['stations'][0]['v']['pm25']=[12,175];write(p/'stations.json',doc)
            with self.assertRaisesRegex(ValueError,'no-current'):r.validate_family('openaq',p,START,NOW)
            doc['stations'][0]['v']['pm10']=[15,10];write(p/'stations.json',doc)
            self.assertEqual(r.validate_family('openaq',p,START,NOW)['currentReadings'],1)
            doc['license']['allowed']=[];write(p/'stations.json',doc)
            with self.assertRaisesRegex(ValueError,'license'):r.validate_family('openaq',p,START,NOW)
    def test_buoy_reader_cap_is_four_mib_and_unexpected_files_cannot_be_mounted(self):
        self.assertEqual(r.FAMILIES['buoys'][2],4*1024**2)
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);pack('buoys',p);(p/'unrelated.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'unexpected'):r.validate_family('buoys',p,START,NOW)
            (p/'unrelated.json').unlink();(p/'stations.json').write_bytes(b' '*(4*1024**2+1))
            with self.assertRaisesRegex(ValueError,'byte-bound'):r.validate_family('buoys',p,START,NOW)
    def test_fire_inventory_counts_cell_geometry_and_age_are_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);fires(p);actual=r.validate_family('fires',p,START,NOW)
            self.assertEqual(len(actual['files']),4);self.assertEqual(actual['missingFeeds'],['Suomi NPP'])
            tile=json.loads((p/'tiles/18_9.json').read_text());tile['fires'][0]['acq']=iso(NOW-timedelta(hours=25))
            tile['fires'].append(dict(tile['fires'][0],acq=iso(NOW-timedelta(hours=1))))
            write(p/'tiles/18_9.json',tile)
            legacy=json.loads((p/'fires.json').read_text());legacy['fires']=tile['fires'];write(p/'fires.json',legacy)
            index=json.loads((p/'index.json').read_text());index.update(total=2,detected_total=2,cells={'18_9':2});write(p/'index.json',index)
            overview=json.loads((p/'overview.json').read_text());overview['fires'][0]['count']=2;write(p/'overview.json',overview)
            r.validate_family('fires',p,START,NOW) # old tail within36h and one genuine current detection
            for change in ['missing','extra','count','geometry','age']:
                fires(p)
                if change=='missing':(p/'tiles/18_9.json').unlink()
                elif change=='extra':write(p/'tiles/17_9.json',tile)
                else:
                    t=json.loads((p/'tiles/18_9.json').read_text())
                    if change=='count':t['fires']=[]
                    elif change=='geometry':t['fires'][0]['lon']=-11
                    else:t['fires'][0]['acq']=iso(NOW-timedelta(hours=37))
                    write(p/'tiles/18_9.json',t)
                with self.subTest(change=change),self.assertRaises((ValueError,FileNotFoundError)):r.validate_family('fires',p,START,NOW)
                if (p/'tiles/17_9.json').exists():(p/'tiles/17_9.json').unlink()
    def test_fire_thinning_preserves_detected_counts_and_fixed_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)
            def valid():
                fires(p);receipt=dict(detected=2,kept=1,rule=r.THIN_RULE)
                legacy=json.loads((p/'fires.json').read_text());legacy['thinned']=receipt;write(p/'fires.json',legacy)
                tile=json.loads((p/'tiles/18_9.json').read_text());tile['thinned']=receipt;write(p/'tiles/18_9.json',tile)
                index=json.loads((p/'index.json').read_text());index.update(detected_total=2,thinned={'rule':r.THIN_RULE,'cells':{'18_9':receipt}});write(p/'index.json',index)
                overview=json.loads((p/'overview.json').read_text());overview['fires'][0]['count']=2;write(p/'overview.json',overview)
            valid();self.assertEqual(r.validate_family('fires',p,START,NOW)['rows'],1)
            for change in ['kept','detected','rule','overview-count','extra-receipt']:
                valid()
                if change=='overview-count':
                    d=json.loads((p/'overview.json').read_text());d['fires'][0]['count']=3;write(p/'overview.json',d)
                else:
                    d=json.loads((p/'index.json').read_text())
                    if change=='extra-receipt':d['thinned']['cells']['17_9']=d['thinned']['cells']['18_9']
                    elif change=='rule':d['thinned']['rule']='invented thinning'
                    else:d['thinned']['cells']['18_9'][change]=3
                    write(p/'index.json',d)
                with self.subTest(change=change),self.assertRaises(ValueError):r.validate_family('fires',p,START,NOW)

    def test_all_five_guard_refuses_one_of_four_success_and_byte_tampering(self):
        receipt=dict(schemaVersion=1,sourceSha=r.SOURCE,startedAt=iso(START),families={'metar':{}})
        with self.assertRaisesRegex(ValueError,'all-five'):r.validate_all(Path('/none'),Path('/none'),receipt,NOW)
        with tempfile.TemporaryDirectory() as tmp:
            stage=Path(tmp);rows={}
            for family in r.FAMILIES:
                if family=='fires':fires(stage/family)
                else:pack(family,stage/family)
                rows[family]=r.validate_family(family,stage/family,START,NOW)
            receipt['families']=rows
            with patch.object(r,'native_validate') as native:
                r.validate_all(Path('/none'),stage,receipt,NOW);self.assertEqual(native.call_count,5)
                doc=json.loads((stage/'metar/metar.json').read_text());doc['source']='changed';write(stage/'metar/metar.json',doc)
                with self.assertRaisesRegex(ValueError,'bytes-changed'):r.validate_all(Path('/none'),stage,receipt,NOW)
    def test_collector_subprocess_environment_excludes_writer_keys(self):
        with patch.dict(r.os.environ,{'OPENAQ_API_KEY':'private','CATALOG_PROMOTION_KEY':'private','GH_TOKEN':'private',
                                    'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY':'private'}):
            env=r.safe_env();self.assertNotIn('OPENAQ_API_KEY',env);self.assertNotIn('GH_TOKEN',env)
            self.assertNotIn('CATALOG_PROMOTION_KEY',env);self.assertNotIn('RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY',env)

if __name__=='__main__':unittest.main()
