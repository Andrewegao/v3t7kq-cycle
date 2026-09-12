# Bake throughput qualification

`qualify-bake-throughput.yml` is a manual, nonpublishing safety gate for the
reviewed Atmos production-source candidate. It does not contact a weather
provider and receives only the isolated read-only Atmos checkout key.

The job holds the unattended GFS bake's 25 full-grid float32 arrays in memory:
five core fields, fourteen extra fields, the retained point-gust copy, and five
wave fields. It alternates two full serial and two full bounded two-writer runs.
It requires identical hashes for all 1,460 PNGs, both parallel observations to
beat both serial observations by at least five percent, and at least 1 GiB of
sampled runner memory headroom. The receipt records kernel high-water RSS and
the sampled process and runner measurements. It is written before a performance
or headroom refusal, then printed in the log and job summary.

This diagnostic does not approve or activate a source pin. Production and
staging source changes remain separate reviewed operations.
