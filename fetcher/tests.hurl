########
# Setup
########

PUT http://localhost:8787/put_object?name=ff01234
```
alpha1 map contents
```

HTTP 200


# Ignoring in the body a bunch of required fields for now
PUT http://localhost:8787/put_kv?key=from_name%2Fmap%2Falpha1
```json
{
    "filename": "alpha1.txt",
    "springname": "alpha1",
    "md5": "ff01234",
    "mirrors": [
        "file/ff01234/alpha1.txt"
    ]
}
```

HTTP 200


########
# Tests
########

# Finds alpha1 map
GET http://localhost:8787/find?category=map&springname=alpha1

HTTP 200
[Asserts]
jsonpath "$[0].filename" == "alpha1.txt"
jsonpath "$[0].mirrors[0]" == "http://localhost:8787/file/ff01234/alpha1.txt"


# Download alpha1 map fine
GET http://localhost:8787/file/ff01234/alpha1.txt

HTTP 200
Cache-Control: public, max-age=31536000, immutable
[Asserts]
body == "alpha1 map contents\n"


# Download map is from cache, we only know after one download
GET http://localhost:8787/file/ff01234/alpha1.txt

HTTP 200
X-Fetcher-Source: cache
[Asserts]
body == "alpha1 map contents\n"

# Force map download not from cache
GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache

HTTP 200

[Asserts]
header "X-Fetcher-Source" != "cache"


# Falls back to springfiles (this might be flaky test)
GET http://localhost:8787/find?category=map&springname=Canis%20River%20v1.0

HTTP 200
[Asserts]
jsonpath "$[0].md5" == "acd611322b4722278a63b76f2bf4cb5a"
jsonpath "$[0].mirrors[0]" startsWith "https://springfiles.springrts.com/"


# Missing category
GET http://localhost:8787/find?springname=map1

HTTP 400


# Unrecognized category
GET http://localhost:8787/find?category=bad&springname=map1

HTTP 302
Location: https://springfiles.springrts.com/json.php?category=bad&springname=map1


# Map not found
GET http://localhost:8787/find?category=map&springname=map1

HTTP 404


# Too long springname
GET http://localhost:8787/find?category=map&springname=asdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasd

HTTP 400


# Unknown request path
GET http://localhost:8787/asd

HTTP 404


# Test direct region override
GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache
X-Fetcher-Region: apac

HTTP 200
X-Fetcher-Source: apac

GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache
X-Fetcher-Region: wnam

HTTP 200
X-Fetcher-Source: wnam


# Test region lookup from position WEUR
GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache
X-Fetcher-Lat: 46.5742096
X-Fetcher-Lon: 9.2805161

HTTP 200
X-Fetcher-Source: weur


# Test region lookup from position WNAM
GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache
X-Fetcher-Lat: -4.3214685
X-Fetcher-Lon: -66.2165546

HTTP 200
X-Fetcher-Source: wnam


# Test region lookup from position APAC
GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache
X-Fetcher-Lat: 7.2874222
X-Fetcher-Lon: 126.0479856

HTTP 200
X-Fetcher-Source: apac

# Test bad data fallback to weur
GET http://localhost:8787/file/ff01234/alpha1.txt
Cache-Control: no-cache
X-Fetcher-Lat: asdasd
X-Fetcher-Lon: asdasd

HTTP 200
X-Fetcher-Source: weur
