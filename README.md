---
# 🐠🐟 phishidon 🐠🐟
___

**work in progress**


##### This is a little put together environment using docker to create two images. 
* One container which uses ZoneStream (https://openintel.nl/data/zonestream) to listen for newly create domain names and logs them to a mongo db. It also flags certain key words and can send it off to a Discord server for notifications.
* Second container is a web frontend where you can search through the domains captured and get information such as registrar, registrant and hosting provider information. It also uses gowitness to do screenshots and keep track of updates of the webpage.



#### requirements

- mongo db
- docker
- need to allow Docker access to File Sharing for /home/user/projects/phishidon/webui/ to allow screenshots to be saved
- configure the .env
 - example

```
MONGO_URI=mongodb://host.docker.internal:27017/deepphish
MONGO_COLLECTION=registered_domains
ABUSEIPDB_API_KEY=<key> (https://www.abuseipdb.com/)
IPINFO_TOKEN=<key> (https://ipinfo.io/)
DISCORD_WEBHOOK_URL=<insert discord hook> (https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
KEYWORDS=word1,word2,word3
PORT=3000
```

#### How to run
- `https://github.com/geoffchisnall/phishidon.git`
- add the .env 
- `docker-compose up --build`


#### TODO
- add the technologies used
- add what services are being used
- add comments
- too tired to think
