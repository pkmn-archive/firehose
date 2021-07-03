# firehose

Pokémon Showdown battles and replays data stream: https://pkmn.github.io/firehose

## Usage

```sh
$ npm install
$ mkdir data
$ npm start
```

The firehose will connect to `psim.us` ("main") and `smogtours.psim.us` ("tours") and continuously
poll for new battles (less than 15 minutes old), publishing the merged stream of battles. Battles
from main will only be published if the minimum Elo rating of the participants exceeds the rating of
the 500th-ranked player on the leaderboard for the format in question at the start of the day.
Furthermore, the firehose tracks the most recent high rated replays for each format and publishes
any new highly rated replays as they get uploaded.

## Protocol

Upon connecting, clients will receive up to 10 of the most recent battles and replays:

```txt
{"battles": [...], "replays": [...]}
```

The server will then begin to stream JSON battle or replay events (battles have a `starttime` field instead of an `uploadtime` field) from either server (battles from the tours server having `rating: 'tours'` instead of a number).

```txt
{"id": "battle-gen8ou-1373985409", ...}
```

The client can optionally attempt to backfill additional battles/replays for a specific format by
sending the format ID to the server, in which case the server's response will be the same shape as
the initial message the client receives upon connection (see above):

```txt
gen4ou
```

## License

This code is distributed under the under the terms of the [MIT License](LICENSE).
