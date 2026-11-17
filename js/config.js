/* Deployment settings. The portal is a static site; everything that differs between the lab-internal copy and the
   public one lives here (or in the URL).

   dataBase   where catalog.json and the monthly/climatology archives live. A page may override it with ?data=/path/
              (same-origin paths only); the lab copy does that and then ignores `hosts`.
   hosts      the public copy spreads the big archives over several GitHub Pages repositories (one site holds at most
              1 GB): catalog.json names a host for each file, this maps host names to base URLs. Same origin as the
              portal, so no CORS questions.
   ncBase     public address of all NetCDF files, once they are deposited; empty = only the Zenodo 2022 file is linked.
   zenodo     the record that holds the 2022 file (the paper's data availability statement).
   contact    who answers questions and requests for the other years. */
window.PORTAL_CONFIG = {
  dataBase: "./data/",
  hosts: {
    f1: "https://hyunglok-kim.github.io/smap-tca-error-portal-fields-1/",
    f2: "https://hyunglok-kim.github.io/smap-tca-error-portal-fields-2/",
    s1: "https://hyunglok-kim.github.io/smap-tca-error-portal-series-1/",
    s2: "https://hyunglok-kim.github.io/smap-tca-error-portal-series-2/",
  },
  ncBase: "",
  zenodo: { doi: "10.5281/zenodo.14850520", url: "https://zenodo.org/records/14850520",
            file: "https://zenodo.org/records/14850520/files/SMAP_VARerr_reconstruct_2022.nc?download=1", years: [2022] },
  paper: { doi: "10.1080/15481603.2025.2475572", url: "https://doi.org/10.1080/15481603.2025.2475572" },
  contactEmail: "hyunglokkim@gist.ac.kr",
  dataContact: "Subin Kim (first author and data manager)",
  dataContactEmail: "subinkim8774@gm.gist.ac.kr",
};
