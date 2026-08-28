# Serves the pre-built Bremen MLD graph over HTTP. The graph itself (bremen-latest.osrm*) is
# built OUTSIDE this image by build-graph.sh and bind-mounted in at runtime (see
# compose.travel-demo.yml) -- this Dockerfile only pins the engine version, it does not bake in
# region data, so rebuilding the graph never requires rebuilding this image.
FROM osrm/osrm-backend:v5.25.0

# --algorithm mld is mandatory, not a style choice: exclude=<class> (avoid_highways/avoid_tolls)
# is only implemented for MLD in this OSRM version, not CH (see osrm/REGIONS.md for the live
# verification against router.project-osrm.org that motivated self-hosting at all).
EXPOSE 5000
ENTRYPOINT ["osrm-routed", "--algorithm", "mld"]
CMD ["/data/bremen-latest.osrm"]
