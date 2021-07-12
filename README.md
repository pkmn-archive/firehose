# firehose

Pokémon Showdown battles and replays data stream: https://pkmn.github.io/firehose

## Usage

```sh
$ npm install
$ mkdir data
$ npm start
```

The firehose will connect to `psim.us` ("main") and `smogtours.psim.us` ("tours") and continuously
poll for new battles (less than 15 minutes old), publishing the merged stream of battles. By
default, battles from main will only be published if the minimum Elo rating of the participants
exceeds the rating of the 500th-ranked player on the leaderboard for the format in question at the
start of the day. Furthermore, the firehose tracks the most recent high rated/tours replays for each
format and publishes any new matching replays as they get uploaded.

## Protocol

Upon connecting, clients will receive a 'backfill' of up to 10 of the most recent tour/highly-rated
battles and of up to 10 of the most recent tour/highly-rated replays. Each battle or replay will be
on its own line, and take the form of:

```txt
type|id|p1|p2|time|rating|threshold
```

- **type**: will either be `battle` or `replay`.
- **id**: will be the Pokémon Showdown room ID of the battle or replay. This currently contains the
  format and an integer, though may also start with `smogtours-` if the ID comes from a tours
  replay.
- **p1**, **p2**: the display names for the players in the battle.
- **time**: the time the battle was broadcast by Pokémon Showdown (approximately the start time) or
  the upload time of the replay, in seconds since the epoch.
- **rating**: the rating of the battle if the battle was rated, otherwise empty.
- **threshold**: the cutoff for the 500th-ranked player on the ladder for the format in question,
  *only included if the battle took place on main*.

The server will then begin to stream further battle or replay events from either main/tours (events
from the tours server will not have a `threshold`).

The client can opt-in to the entire unfiltered battles/replays stream (ie. battles/replays of all
ratings) by sending just `*`:

```txt
*
```

This will cause a further backfill of the 10 most recent battles and 10 most recent replays. To
switch back to just highly-rated battles/replays, the client should send `^` (which will not respond
with a further backfill as the highly-rated battles/replays are a subset of the unfiltered stream):

```txt
^
```

The client can optionally attempt to backfill additional battles/replays for a specific format by
sending the format ID to the server, in which case the server will respond with all battles/replays
that it has saved that meet the filter mode requirements and match the format in question.

```txt
gen4ou
```

## License

This code is distributed under the under the terms of the [MIT License](LICENSE).
