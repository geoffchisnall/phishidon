require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const moment = require("moment");
const whois = require("whois-json");
const dns = require("dns").promises;
const axios = require("axios");
const { exec } = require('child_process');
const util = require('util');
//const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs');
const router = express.Router();

const app = express();
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ✅ MongoDB Connection
mongoose.connect(process.env.MONGO_URI).then(() => {
  console.log("🚀 Connected to MongoDB");
}).catch((error) => {
  console.error("❌ MongoDB connection failed:", error);
  process.exit(1);
});

const domainSchema = new mongoose.Schema({
  domain: { type: String, required: true },
  timestamp: { type: Number, required: true },
});
const collectionName = process.env.MONGO_COLLECTION || "confirmed_newly_registered_domains";
const Domain = mongoose.model("Domain", domainSchema, collectionName);


// 🏠 Home Page
app.get("/", async (req, res) => {
  try {
    const perDayCountsRaw = await Domain.aggregate([
      { $match: { timestamp: { $ne: null } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $toDate: { $multiply: ["$timestamp", 1000] } }
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    const perDayCounts = Object.fromEntries(perDayCountsRaw.map(e => [e._id, e.count]));
    res.render("front", { perDayCounts });
  } catch (err) {
    console.error("Error rendering front page:", err);
    res.status(500).send("Internal Server Error");
  }
});

// 🔍 Search
app.get("/search", async (req, res) => {
  try {
    const { domain, page = 1 } = req.query;
    const limit = 50;
    const skip = (Math.max(1, parseInt(page)) - 1) * limit;

    const query = domain ? { domain: { $regex: domain, $options: "i" } } : {};

    const totalSearchResults = await Domain.countDocuments(query);
    const results = await Domain.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit);
    const totalDomains = await Domain.countDocuments();
    const totalPages = Math.ceil(totalSearchResults / limit);

    res.render("search", {
      results,
      domain,
      moment,
      totalDomains,
      totalSearchResults,
      searchResultsCount: results.length,
      page: parseInt(page),
      totalPages
    });
  } catch (error) {
    console.error("❌ Search error:", error);
    res.status(500).send("Error loading search page");
  }
});

// 📊 Stats
app.get("/stats", async (req, res) => {
  try {
    const perDayCounts = await Domain.aggregate([
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $toDate: { $multiply: ["$timestamp", 1000] } }
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: -1 } }
    ]);

    const tldCounts = await Domain.aggregate([
      {
        $project: {
          tld: {
            $toLower: {
              $arrayElemAt: [{ $split: ["$domain", "."] }, -1]
            }
          }
        }
      },
      {
        $group: {
          _id: "$tld",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const tldPerDay = await Domain.aggregate([
      {
        $project: {
          date: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $toDate: { $multiply: ["$timestamp", 1000] } }
            }
          },
          tld: {
            $toLower: {
              $arrayElemAt: [{ $split: ["$domain", "."] }, -1]
            }
          }
        }
      },
      {
        $group: {
          _id: { date: "$date", tld: "$tld" },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.date",
          tlds: {
            $push: { tld: "$_id.tld", count: "$count" }
          }
        }
      },
      { $sort: { _id: -1 } }
    ]);

    const perDayObj = Object.fromEntries(perDayCounts.map(d => [d._id, d.count]));
    const tldObj = Object.fromEntries(tldCounts.map(t => [t._id, t.count]));
    const tldPerDayObj = {};
    tldPerDay.forEach(day => {
      tldPerDayObj[day._id] = {};
      day.tlds.forEach(({ tld, count }) => {
        tldPerDayObj[day._id][tld] = count;
      });
    });

    res.render("stats", {
      moment,
      perDayCounts: perDayObj,
      tldCounts: tldObj,
      tldPerDay: tldPerDayObj
    });
  } catch (error) {
    console.error("[ERROR] Stats error:", error);
    res.status(500).send("Error loading stats");
  }
});

// 🔍 RDAP Registrar Fallback
const rdapLookup = async (domain) => {
  try {
    console.log(`[DEBUG] Starting RDAP lookup for ${domain}`);
    const { data } = await axios.get(`https://rdap.org/domain/${domain}`);
    console.log(`[DEBUG] RDAP response for ${domain}:`, data);

    let registrar = "N/A";
    let registrarAbuseEmail = "N/A";

    const registrarEntity = data.entities?.find(e =>
      Array.isArray(e.roles) && e.roles.includes("registrar")
    );

    if (registrarEntity) {
      registrar = registrarEntity.vcardArray?.[1]?.find(v => v[0] === "fn")?.[3] || registrar;
      console.log(`[DEBUG] Found registrar: ${registrar}`);

      const abuseEntity = (registrarEntity.entities || []).find(e =>
        Array.isArray(e.roles) && e.roles.includes("abuse")
      );

      if (abuseEntity) {
        const abuseEmail = abuseEntity.vcardArray?.[1]?.find(v => v[0] === "email")?.[3];
        if (abuseEmail) {
          registrarAbuseEmail = abuseEmail;
          console.log(`[DEBUG] Found abuse email: ${registrarAbuseEmail}`);
        }
      }
    }

    return { registrar, registrarAbuseEmail };
  } catch (error) {
    console.error(`[DEBUG] RDAP lookup failed for ${domain}:`, error.response?.data || error.message);
    return null;
  }
};
// AbuseIPDB
const getHostingAbuseFromAbuseIPDB = async (ip) => {
  try {
    console.log(`[DEBUG] Checking AbuseIPDB for abuse email for IP ${ip}`);
    const { data } = await axios.get(`https://api.abuseipdb.com/api/v2/check`, {
      params: {
        ipAddress: ip,
        maxAgeInDays: 90
      },
      headers: {
        Key: process.env.ABUSEIPDB_API_KEY,
        Accept: "application/json"
      }
    });

    const contacts = data.data.email_contacts;
    if (contacts && contacts.length > 0) {
      console.log(`[DEBUG] Found AbuseIPDB email contacts:`, contacts);
      return contacts[0]; // return the first email found
    }
  } catch (error) {
    console.error(`[DEBUG] AbuseIPDB lookup failed for IP ${ip}:`, error.response?.data || error.message);
  }
  return "N/A";
};


// 🧩 Hosting provider abuse RDAP fallback with IPInfo failover
 const getHostingAbuseFromIPInfo = async (ipv4) => {
  try {
    console.log(`[DEBUG] Fetching abuse email from IPInfo for IP ${ipv4}`);
    const ipinfoRes = await axios.get(`https://ipinfo.io/${ipv4}/json?token=${process.env.IPINFO_TOKEN}`);
    const ipinfo = ipinfoRes.data;

    console.log(`[DEBUG] IPInfo Response for IP ${ipv4}:`, ipinfo);  // Log the whole response for debugging

    // Look for abuse contact info in the response
    if (ipinfo.abuse && ipinfo.abuse.contact) {
      console.log(`[DEBUG] Found abuse contact in IPInfo: ${ipinfo.abuse.contact}`);
      return ipinfo.abuse.contact;
    } else {
      console.log(`[DEBUG] No abuse email found in IPInfo for ${ipv4}`);
    }
  } catch (error) {
    console.error(`[DEBUG] Error fetching abuse info from IPInfo for IP ${ipv4}:`, error.message);
  }
  return "N/A";  // Return "N/A" if no abuse email found or error occurs
};

// 🧩 Hosting provider abuse RDAP fallback
const getHostingAbuseFromRDAP = async (ip) => {
  try {
    console.log(`[DEBUG] Starting RDAP lookup for hosting provider with IP ${ip}`);
    const { data } = await axios.get(`https://rdap.arin.net/registry/ip/${ip}`);
    console.log(`[DEBUG] RDAP response for hosting provider with IP ${ip}:`, data);

    const abuseEntity = data.entities?.find(e =>
      Array.isArray(e.roles) && e.roles.includes("abuse")
    );

    if (abuseEntity) {
      const abuseEmail = abuseEntity.vcardArray?.[1]?.find(v => v[0] === "email")?.[3];
      return abuseEmail || "N/A";
    }
  } catch (error) {
    console.error(`[DEBUG] RDAP hosting provider lookup failed for IP ${ip}:`, error.response?.data || error.message);
  }
  return "N/A";
};

// 🕵️ WHOIS + RDAP + IPINFO
// Your helper functions:
app.get("/whois/:domain", async (req, res) => {
  const domain = req.params.domain;

  try {
    console.log(`[DEBUG] Starting WHOIS lookup for ${domain}`);

    let whoisData = {};
    try {
      whoisData = await whois(domain);
      console.log(`[DEBUG] WHOIS raw output:\n${whoisData.raw || JSON.stringify(whoisData, null, 2)}`);
    } catch (err) {
      console.error(`[DEBUG] WHOIS lookup failed:`, err.code || err.message);
      if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(err.code)) {
        whoisData = {};
      } else {
        throw err;
      }
    }

    // Extract registrant info
    const registrant = {
      name: whoisData.registrantName || whoisData["Registrant Name"] || null,
      email: whoisData.registrantEmail || whoisData["Registrant Email"] || null,
      org: whoisData.registrantOrganization || whoisData["Registrant Organization"] || null,
      country: whoisData.registrantCountry || whoisData["Registrant Country"] || null
    };
    console.log(`[DEBUG] Registrant info extracted:`, registrant);

    // Fallback to RDAP if needed
    if (!whoisData.registrar || !whoisData.registrarAbuseContactEmail) {
      const rdapData = await rdapLookup(domain);
      console.log(`[DEBUG] RDAP data:`, rdapData);

      if (rdapData) {
        whoisData.registrar ??= rdapData.registrar;
        whoisData.registrarAbuseContactEmail ??= rdapData.registrarAbuseEmail;
      }
    }

    const registrar = {
      value: whoisData.registrar || "N/A",
      source: whoisData.registrar ? "whois" : "rdap"
    };

    const registrarAbuseEmail = {
      value: whoisData.registrarAbuseContactEmail || whoisData.abuseEmail || "N/A",
      source: (whoisData.registrarAbuseContactEmail || whoisData.abuseEmail) ? "whois" : "rdap"
    };

    // IP & hosting data
    let ipv4 = null;
    let asn = "N/A", isp = "N/A", hostingAbuseEmail = { value: "N/A", source: "N/A" };

    try {
      const addresses = await dns.lookup(domain, { all: true });
      ipv4 = addresses.find(a => a.family === 4)?.address;
      if (ipv4) {
        console.log(`[DEBUG] IPv4 for ${domain}:`, ipv4);

        const ipinfoRes = await axios.get(`https://ipinfo.io/${ipv4}/json?token=${process.env.IPINFO_TOKEN}`);
        const ipinfo = ipinfoRes.data;

        if (ipinfo.org) {
          const parts = ipinfo.org.split(" ");
          asn = parts[0];
          isp = parts.slice(1).join(" ");
        }

        const abuseIPDBEmail = await getHostingAbuseFromAbuseIPDB(ipv4);
        if (abuseIPDBEmail && abuseIPDBEmail !== "N/A") {
          hostingAbuseEmail = { value: abuseIPDBEmail, source: "abuseipdb" };
        } else if (ipinfo.abuse?.contact) {
          hostingAbuseEmail = { value: ipinfo.abuse.contact, source: "ipinfo" };
        } else {
          const rdapAbuse = await getHostingAbuseFromRDAP(ipv4);
          if (rdapAbuse && rdapAbuse !== "N/A") {
            hostingAbuseEmail = { value: rdapAbuse, source: "rdap" };
          }
        }
      }
    } catch (err) {
      console.warn(`[DEBUG] DNS or IPInfo resolution failed:`, err.message);
    }

    res.json({
      domain,
      ipv4: ipv4 || "N/A",
      asn,
      isp,
      registrar,
      registrarAbuseEmail,
      hostingAbuseEmail,
      registrant
    });

  } catch (err) {
    console.error(`[DEBUG] WHOIS error for ${domain}:`, err);
    res.status(500).json({ error: "WHOIS lookup failed." });
  }
});
 
// Serve static screenshots
app.use('/gowitness-shots', express.static(path.join(__dirname, 'gowitness-shots')));

app.get('/screenshot/:domain', (req, res) => {
  const domain = req.params.domain;
  const sanitized = domain.replace(/[^a-zA-Z0-9.-]/g, '');
  const outputDir = path.join(__dirname, 'gowitness-shots');
  const newPath = path.join(outputDir, `http---${sanitized}.png`);
  const oldPath = path.join(outputDir, `http---${sanitized}-older.png`);

  console.log(`[DEBUG] Screenshot request for: ${domain}`);

  // If we are forcing a new screenshot capture (via query parameter)
  const forceNew = req.query.force === 'true';

  // Step 1: Check if the screenshot is already cached and if not forced to fetch new one
  if (!forceNew && fs.existsSync(newPath)) {
    console.log(`[DEBUG] Screenshot already cached. Returning cached screenshot.`);
    return res.json({
      current: `/gowitness-shots/http---${sanitized}.png`,
      old: fs.existsSync(oldPath) ? `/gowitness-shots/http---${sanitized}-older.png` : null,
      currentTimestamp: fs.statSync(newPath).mtime.toISOString(),
      oldTimestamp: fs.existsSync(oldPath) ? fs.statSync(oldPath).mtime.toISOString() : null,
    });
  }

  // Step 2: If not cached or forced to regenerate, generate the screenshot
  const url = `http://${sanitized}`;
  const cmd = `gowitness scan single --url=${url} --delay 15 -s ${outputDir} --screenshot-format png`;

  console.log(`[DEBUG] Executing gowitness: ${cmd}`);
  exec(cmd, (err, stdout, stderr) => {
    console.log(`[DEBUG] gowitness stdout:\n${stdout}`);
    if (err) {
      console.error(`[DEBUG] gowitness error: ${err.message}`);
      return res.json({ error: 'Screenshot capture failed.' });
    }

    // Step 3: Check again if the screenshot was generated
    if (fs.existsSync(newPath)) {
      // Backup the previous screenshot if it exists
      if (fs.existsSync(newPath) && !fs.existsSync(oldPath)) {
        fs.copyFileSync(newPath, oldPath);
        console.log(`[DEBUG] Backed up original screenshot as 'older' version.`);
      }

      const response = {
        current: `/gowitness-shots/http---${sanitized}.png`,
        old: fs.existsSync(oldPath) ? `/gowitness-shots/http---${sanitized}-older.png` : null,
        currentTimestamp: fs.statSync(newPath).mtime.toISOString(),
        oldTimestamp: fs.existsSync(oldPath) ? fs.statSync(oldPath).mtime.toISOString() : null,
      };

      console.log(`[DEBUG] Screenshot generated and cached. Returning response:`, response);
      return res.json(response);
    } else {
      console.warn(`[DEBUG] Screenshot not found after gowitness execution.`);
      return res.json({ error: 'Screenshot not found after capture.' });
    }
  });
});

app.get("/subfinder_lookup", (req, res) => {
  res.render("subfinder_lookup"); // lookup.ejs from earlier with input + button
});
// Utility to handle command execution

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));  // Reject with the error message
      } else {
        resolve(stdout);  // Resolve with the standard output
      }
    });
  });
}

//app.use('/subfinder-shots', express.static(path.join(__dirname, 'gowitness-shots/subfinder')));
////app.use('/subfinder-shots', express.static(path.join(__dirname, 'gowitness-shots/subfinder')));

app.get("/subfinder/:domain", async (req, res) => {
  const domain = req.params.domain;
  const sanitized = domain.replace(/[^a-zA-Z0-9.-]/g, "");
  const pathArg = req.query.path || "index.html";
  const tmpFile = `/tmp/subs-${sanitized}.txt`;
  const outputDir = path.join(__dirname, "gowitness-shots/subfinder");
  const results = [];

  try {
    // Step 1: Run subfinder
    const subfinderCmd = `subfinder -d ${sanitized} -silent`;
    console.log(`[DEBUG] Running: ${subfinderCmd}`);
    const subs = await execPromise(subfinderCmd);

    if (!subs.trim()) {
      return res.status(404).json({ error: "No subdomains found" });
    }

    // Step 2: Save subdomains to temp file
    fs.writeFileSync(tmpFile, subs);

    // Step 3: Run httpx to get live subdomains
    const httpxCmd = `cat ${tmpFile} | /home/mooncake/go/bin/httpx -silent -mc 200 -path ${pathArg}`;
    console.log(`[DEBUG] Running: ${httpxCmd}`);
    const liveHosts = await execPromise(httpxCmd);

    if (!liveHosts.trim()) {
      return res.status(404).json({ error: "No HTTP 200 live subdomains found" });
    }

    // Step 4: Ensure gowitness-shots/subfinder exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Step 5: Take screenshots with gowitness
    const hosts = liveHosts.trim().split("\n");
    const urls = hosts.map(line => line.split(" ")[0]); // just the URLs

    // Save the URLs to a file
    const urlsFile = path.join(__dirname, "gowitness-shots/subfinder", `${sanitized}-urls.txt`);
    fs.writeFileSync(urlsFile, urls.join("\n"));
    console.log(`[DEBUG] Saved URLs to: ${urlsFile}`);

    for (const url of urls) {
      const gowitnessCmd = `gowitness scan single --url ${url} --screenshot-fullpage --screenshot-format png -s ${outputDir}`;
      console.log(`[DEBUG] Running: ${gowitnessCmd}`);
      await execPromise(gowitnessCmd);

      // Derive gowitness screenshot filename
      const parsedUrl = new URL(url);
      const gowitnessName = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`.replace(/[:\/]/g, '-');
      const screenshotFile = `${gowitnessName}.png`;
      const screenshotPath = path.join(outputDir, screenshotFile);

      if (fs.existsSync(screenshotPath)) {
        const timestamp = fs.statSync(screenshotPath).mtime.getTime();
        results.push({
          url,
          screenshot: `/gowitness-shots/subfinder/${screenshotFile}`,
        });
      } else {
        console.warn(`[WARN] Screenshot not found: ${screenshotFile}`);
      }
    }

    res.json({ results });
  } catch (error) {
    console.error("[ERROR]", error);
    res.status(500).json({ error: "An error occurred while processing the request" });
  }
});

app.get("/screenshots", (req, res) => {
  const shotsDir = path.join(__dirname, "gowitness-shots/subfinder");

  fs.readdir(shotsDir, (err, files) => {
    if (err) {
      console.error("[ERROR] Failed to read screenshots directory:", err);
      return res.status(500).send("Failed to load screenshots");
    }

    // Filter for PNG screenshots (you can adjust this if needed)
    const screenshots = files
      .filter(f => f.endsWith(".png"))
      .map(filename => ({
        filename,
        url: `/gowitness-shots/subfinder/${filename}`,
        modified: fs.statSync(path.join(shotsDir, filename)).mtime
      }))
      .sort((a, b) => b.modified - a.modified); // newest first

    res.render("screenshots", { screenshots, moment });
  });
});

// In your Express app (e.g., app.js or routes file)

app.get('/details/:domain', async (req, res) => {
  const domain = req.params.domain;

  // Here you can fetch any additional data you want to display on the details page,
  // e.g., WHOIS info, screenshots, RDAP data, or other domain details.
  // For now, let's just send the domain name for demonstration.

  // Example: Fetch WHOIS info (if you have a function or API to do so)
  // const whoisData = await fetchWhois(domain);

  res.render('details', {
    domain,
    // whoisData, // pass extra data as needed
  });
});





// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

