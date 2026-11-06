/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable no-invalid-this */

'use strict';

class MeetWrapper { // eslint-disable-line
  #currentRoom;
  #hasBeenActivated = false;
  // Index into #ADJUST_VIEW_OPTIONS for the "adjust view" cycle button.
  // Starts at -1 so the first press selects the first option.
  #adjustViewIndex = -1;

  // True while an adjust-view operation (open menu -> open panel -> select
  // option -> wait for close) is in flight. A second press must never
  // start while the previous panel is still closing: interrupting the
  // close animation wedges Meet's overlay manager and the three-dot menu
  // stops opening altogether.
  #adjustViewBusy = false;

  // Index of the highlighted meeting card in the lobby (see
  // #getLobbyMeetingCards). The tab button moves this, the select button
  // activates the card at this index. Wraps around in both directions.
  #lobbyHighlightIndex = 0;

  // Set once the user has pressed tab in the current lobby visit; stops
  // the initial-ring retry loop from clobbering the highlight.
  #lobbyHighlightTouched = false;

  // The "Adjust view" submenu (under the three-dot "More options" menu)
  // offers several ways to frame the participants. These are cycled in
  // order by the adjust-view button. The strings below are matched against
  // the menu item text (case-insensitive substring), so "Auto" matches the
  // "Auto frame" item. Add more entries to cycle through more options, and
  // update them if Google ever renames the menu items.
  #ADJUST_VIEW_OPTIONS = ['Spotlight', 'Auto'];

  #ROOM_NAMES = {
    lobby: 'lobby',
    greenRoom: 'greenRoom',
    meeting: 'meeting',
    exitHall: 'exitHall',
  };

  #streamDeck;

  /**
   * Constructor
   *
   * @param {HIDDevice} streamDeck
   */
  constructor(streamDeck) {
    this.#streamDeck = streamDeck;
    this.#streamDeck.addEventListener('keydown', (evt) => {
      this.#handleStreamDeckPress(evt.detail.buttonId);
    });

    window.addEventListener('fullscreenchange', () => {
      this.#drawFullScreenButton();
    });

    window.addEventListener('click', () => {
      if (this.#hasBeenActivated || !navigator.userActivation.isActive) {
        return;
      }
      this.#hasBeenActivated = true;
      this.#drawFullScreenButton();
    });

    // Google Meet's lobby page has moved over time (/ -> /landing -> /home),
    // so accept all known paths. The green room, meeting, and exit hall are
    // all served from the meeting URL and reached either as a fresh document
    // load (lobby -> green room) or as same-document updates (green room ->
    // meeting -> exit hall). We therefore detect the room both once up front
    // and continuously via a mutation observer: on a fresh load the room's
    // DOM is often already present before any mutation fires, so the observer
    // alone would never run and the green room would go undetected.
    const pathname = window.location.pathname;
    const isLobby = pathname === '/' || pathname === '/landing' ||
        pathname === '/home';

    const handleRoom = () => {
      const room = this.#detectRoom();
      if (room === this.#ROOM_NAMES.exitHall) {
        this.#enterExitHall();
      } else if (room === this.#ROOM_NAMES.meeting) {
        this.#enterMeeting();
      } else if (room === this.#ROOM_NAMES.greenRoom) {
        this.#enterGreenRoom();
      } else if (isLobby) {
        this.#enterLobby();
      }
    };

    // Detect immediately, then keep watching. Every #enter* method is
    // idempotent, so re-running this on each mutation is safe.
    handleRoom();

    const bodyObserver = new MutationObserver(handleRoom);
    bodyObserver.observe(document.body, {attributes: true, childList: true});
  }

  /**
   * Determine which "room" the current page is in, based on stable
   * markers in the DOM. Returns one of the #ROOM_NAMES values, or null
   * if no known room is detected.
   *
   * The exit hall is checked first because its heading is unique to that
   * screen; the meeting is checked before the green room because the
   * green room's "Join" button can look similar to meeting controls.
   *
   * @return {?string}
   */
  #detectRoom() {
    // A hang-up control is only present while actually in a call. It is
    // the strongest "in meeting" signal, so grab it up front: while it is
    // on screen we can NEVER be in the exit hall, no matter what other
    // markers are in the DOM.
    const hangup = document.querySelector(
        '[aria-label="Leave call"], [aria-label="End call for everyone"]');

    // Exit hall: the "You left the meeting" heading. Do NOT match on
    // [jsname="r4nke"] alone — short jsname hashes are reused by
    // unrelated components in lazily-loaded chunks (opening the
    // "Adjust view" panel used to add such an element and flip the
    // detected room to exit hall mid-meeting). Require the h1 tag AND
    // the heading text, and never report the exit hall while a hang-up
    // control is visible.
    if (!hangup) {
      const h1 = document.querySelector('h1[jsname="r4nke"]');
      if (h1 && /left the meeting/i.test(h1.textContent || '')) {
        return this.#ROOM_NAMES.exitHall;
      }
    }

    // Green room is checked BEFORE the meeting: its "Join now" / "Join
    // without camera" button is unique to the green room, whereas the
    // meeting's markers (a hang-up control or a runtime-injected
    // [data-meeting-title]) can also be present in the green room's live
    // preview. Checking the green room first avoids mis-detecting it as a
    // meeting, which is what made the join button disappear.
    const join = this.#findButtonByText(
        ['Join now', 'Join without camera', 'Join with camera']);
    if (join || document.querySelector('[jscontroller="dyDNGc"]')) {
      return this.#ROOM_NAMES.greenRoom;
    }

    // Meeting: a hang-up control is only present while in a call.
    if (hangup || document.querySelector('div[data-meeting-title]')) {
      return this.#ROOM_NAMES.meeting;
    }

    return null;
  }


  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Methods for setting up the rooms.
   *
   */

  /**
   * Set up buttons for the lobby.
   */
  #enterLobby() {
    if (this.#currentRoom === this.#ROOM_NAMES.lobby) {
      return;
    }
    this.#currentRoom = this.#ROOM_NAMES.lobby;
    console.log('*SD-Meet*', 'Room:', this.#currentRoom);

    this.#lobbyHighlightIndex = 0;
    this.#lobbyHighlightTouched = false;
    this.#resetButtons();
    this.#drawFullScreenButton();
    this.#drawButton(`start-next`);
    this.#drawButton(`start-instant`);
    this.#drawButton(`previous`);
    this.#drawButton(`next`);

    for (let attempt = 0; attempt < 10; attempt++) {
      setTimeout(() => {
        if (this.#currentRoom === this.#ROOM_NAMES.lobby &&
            !this.#lobbyHighlightTouched) {
          const cards = this.#getLobbyMeetingCards();
          if (cards.length > 0) {
            this.#lobbyHighlightIndex = this.#getInitialLobbyHighlightIndex(cards);
            const card = cards[this.#lobbyHighlightIndex];
            if (card) {
              this.#setLobbyHighlightRing(card);
            }
          }
        }
      }, 300 * (attempt + 1));
    }
  }

  /**
   * Set up buttons for the green room.
   */
  #enterGreenRoom() {
    if (this.#currentRoom === this.#ROOM_NAMES.greenRoom) {
      return;
    }
    this.#currentRoom = this.#ROOM_NAMES.greenRoom;
    console.log('*SD-Meet*', 'Room:', this.#currentRoom);

    this.#resetButtons();
    this.#drawFullScreenButton();
    this.#drawButton(`enter-meeting`);
    this.#drawButton(`home`);

    // The timeout is there to make sure the elements have drawn on
    // screen. I should probably use a mutation observer to see when they
    // drawn, then render them, but I'm feeling kinda lazy today.
    setTimeout(() => {
      this.#setupGreenRoomMicButton();
      this.#setupGreenRoomCamButton();
    }, 500);
  }

  /**
   * Set up buttons for the meeting room.
   */
  #enterMeeting() {
    if (this.#currentRoom === this.#ROOM_NAMES.meeting) {
      return;
    }
    this.#currentRoom = this.#ROOM_NAMES.meeting;
    console.log('*SD-Meet*', 'Room:', this.#currentRoom);

    // Each new meeting starts the "adjust view" cycle from the beginning.
    this.#adjustViewIndex = -1;

    this.#resetButtons();
    this.#drawFullScreenButton();
    this.#drawButton(`end-call`);
    // Adjust view is temporarily disabled (see the matching commented-out
    // press handler in #handleStreamDeckPress and #tapAdjustView below).
    // Re-enable both together.
    // this.#drawButton(`adjust-view`);

    // The timeout is there to make sure the elements have drawn on
    // screen. I should probably use a mutation observer to see when they
    // drawn, then render them, but I'm feeling kinda lazy today.
    setTimeout(() => {
      this.#setupMicButton();
      this.#setupCamButton();
      this.#setupCCButton();
      this.#setupHandButton();
      this.#setupInfoButton();
      this.#setupPeopleButton();
      this.#setupChatButton();
      this.#setupActivitiesButton();
      this.#setupPresentingButton();
      this.#setupReactionButton();
    }, 500);

    // If it was an instant meeting, automatically close
    // the info dialog after 10 seconds.
    setTimeout(() => {
      this.#tapCloseInfoDialog();
    }, 10 * 1000);
  }

  /**
   * Set up buttons for the exit hall.
   */
  #enterExitHall() {
    if (this.#currentRoom === this.#ROOM_NAMES.exitHall) {
      return;
    }
    this.#currentRoom = this.#ROOM_NAMES.exitHall;
    console.log('*SD-Meet*', 'Room:', this.#currentRoom);

    this.#resetButtons();
    this.#drawFullScreenButton();
    this.#drawButton(`rejoin`);
    this.#drawButton(`home`);
  }


  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Methods for interacting with the Stream Deck.
   *
   */

  /**
   * Handle called when a button is pressed.
   *
   * @param {number} buttonId Button ID of the button that was pressed.
   */
  #handleStreamDeckPress(buttonId) {
    console.log('*SD-Meet*', 'Button Pressed', buttonId);

    // Toggle full screen, used in all rooms.
    if (buttonId === this.#streamDeck.buttonNameToId('fullscreen-on')) {
      this.#toggleFullScreen();
      return;
    }

    // Available while in the lobby.
    if (this.#currentRoom === this.#ROOM_NAMES.lobby) {
      if (buttonId === this.#streamDeck.buttonNameToId('start-next')) {
        this.#tapStartNextMeeting();
      } else if (buttonId === this.#streamDeck.buttonNameToId('previous')) {
        this.#tapLobbyPrevious();
      } else if (buttonId === this.#streamDeck.buttonNameToId('next')) {
        this.#tapLobbyNext();
      } else if (buttonId === this.#streamDeck.buttonNameToId('start-instant')) { // eslint-disable-line
        this.#tapStartInstantMeeting();
      }
      return;
    }

    // Available while in the green room.
    if (this.#currentRoom === this.#ROOM_NAMES.greenRoom) {
      if (buttonId === this.#streamDeck.buttonNameToId('enter-meeting')) {
        this.#tapEnterMeeting();
      } else if (buttonId === this.#streamDeck.buttonNameToId('mic')) {
        this.#tapGreenRoomMic();
      } else if (buttonId === this.#streamDeck.buttonNameToId('cam')) {
        this.#tapGreenRoomCam();
      } else if (buttonId === this.#streamDeck.buttonNameToId('home')) {
        this.#resetButtons();
        window.history.back();
      }
      return;
    }

    // Available while in the meeting room.
    if (this.#currentRoom === this.#ROOM_NAMES.meeting) {
      if (buttonId === this.#streamDeck.buttonNameToId('escape')) {
        this.#dismissOpenMenus();
      } else if (buttonId === this.#streamDeck.buttonNameToId('reaction')) {
        this.#tapReactions();
        // Adjust view is temporarily disabled; re-enable together with the
        // drawButton call in #enterMeeting.
        // } else if (buttonId === this.#streamDeck.buttonNameToId('adjust-view')) {
        //   this.#tapAdjustView();
      } else if (buttonId === this.#streamDeck.buttonNameToId('info')) {
        this.#tapInfo();
      } else if (buttonId === this.#streamDeck.buttonNameToId('users')) {
        this.#tapUsers();
      } else if (buttonId === this.#streamDeck.buttonNameToId('chat')) {
        this.#tapChat();
      } else if (buttonId === this.#streamDeck.buttonNameToId('activities')) {
        this.#tapActivities();
      } else if (buttonId === this.#streamDeck.buttonNameToId('present-stop')) {
        this.#tapStopPresenting();
      } else if (buttonId === this.#streamDeck.buttonNameToId('mic')) {
        this.#tapMic();
      } else if (buttonId === this.#streamDeck.buttonNameToId('cam')) {
        this.#tapCam();
      } else if (buttonId === this.#streamDeck.buttonNameToId('hand')) {
        this.#tapHand();
      } else if (buttonId === this.#streamDeck.buttonNameToId('cc')) {
        this.#tapCC();
      } else if (buttonId === this.#streamDeck.buttonNameToId('end-call')) {
        this.#tapHangUp();
      }
      return;
    }

    // Available while in the exit hall.
    if (this.#currentRoom === this.#ROOM_NAMES.exitHall) {
      if (buttonId === this.#streamDeck.buttonNameToId('rejoin')) {
        this.#tapRejoin();
      } else if (buttonId === this.#streamDeck.buttonNameToId('home')) {
        this.#tapHome();
      }
      return;
    }
  }

  /**
   * Draw an icon on the StreamDeck. Uses the current configuration to
   * determine which button to use based on the icon name.
   *
   * @param {string} iconName Name of icon to draw
   */
  #drawButton(iconName) {
    if (!this.#streamDeck?.isConnected) {
      return;
    }
    const buttonId = this.#streamDeck.buttonNameToId(iconName);
    if (buttonId === undefined || buttonId < 0) {
      console.warn('*SD-Meet*', `drawButton failed, unknown icon name: '${iconName}'`);
      return; // Not defined in the current configuration.
    }
    const iconURL = chrome.runtime.getURL(`ico-svg/${iconName}.svg`);
    this.#streamDeck.fillURL(buttonId, iconURL, true);
  }

  /**
   * Clear the StreamDeck
   */
  #resetButtons() {
    if (!this.#streamDeck?.isConnected) {
      return;
    }
    this.#streamDeck.clearAllButtons();
  }

  /**
   * Draw buttons for full screen toggle.
   */
  #drawFullScreenButton() {
    if (document.fullscreenElement) {
      this.#drawButton(`fullscreen-on`);
      return;
    }
    if (!navigator.userActivation.isActive) {
      this.#drawButton(`fullscreen-disabled`);
      return;
    }
    this.#drawButton(`fullscreen-off`);
  }


  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Set up mutation observers on the buttons in the meeting room.
   *
   */

  /**
   * Setup the meeting room mic button.
   */
  #setupMicButton() {
    const micButton = this.#getMicButton();
    if (!micButton) {
      return;
    }
    const micObserver = new MutationObserver(() => {
      this.#updateMicButton();
    });
    micObserver.observe(micButton, {attributeFilter: ['data-is-muted']});
    this.#updateMicButton();
  }

  /**
   * Setup the meeting room camera button.
   */
  #setupCamButton() {
    const camButton = this.#getCamButton();
    if (!camButton) {
      return;
    }
    const camObserver = new MutationObserver(() => {
      this.#updateCamButton();
    });
    camObserver.observe(camButton, {attributeFilter: ['data-is-muted']});
    this.#updateCamButton();
  }

  /**
   * Setup the meeting room closed caption button.
   */
  #setupCCButton() {
    const ccButton = this.#getCCButton();
    if (!ccButton) {
      return;
    }
    const ccObserver = new MutationObserver(() => {
      this.#updateCCButton();
    });
    ccObserver.observe(ccButton, {attributeFilter: ['aria-pressed']});
    this.#updateCCButton();
  }

  /**
   * Setup the meeting room raise hand button.
   */
  #setupHandButton() {
    const handButton = this.#getHandButton();
    if (!handButton) {
      return;
    }
    const handObserver = new MutationObserver(() => {
      this.#updateHandButton();
    });
    handObserver.observe(handButton, {attributeFilter: ['aria-pressed']});
    this.#updateHandButton();
  }

  /**
   * Setup the meeting room info button.
   */
  #setupInfoButton() {
    const infoButton = this.#getInfoButton();
    if (!infoButton) {
      return;
    }
    const infoObserver = new MutationObserver(() => {
      this.#updateInfoButton();
    });
    infoObserver.observe(infoButton, {attributeFilter: ['aria-pressed']});
    this.#updateInfoButton();
  }

  /**
   * Setup the meeting room people list button.
   */
  #setupPeopleButton() {
    const button = this.#getPeopleButton();
    if (!button) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updatePeopleButton();
    });
    observer.observe(button, {attributeFilter: ['aria-pressed']});
    this.#updatePeopleButton();
  }

  /**
   * Setup the meeting room chat button.
   */
  #setupChatButton() {
    const button = this.#getChatButton();
    if (!button) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updateChatButton();
    });
    observer.observe(button, {attributeFilter: ['aria-pressed']});
    this.#updateChatButton();
  }

  /**
   * Setup the meeting room activities button.
   */
  #setupActivitiesButton() {
    const button = this.#getActivitiesButton();
    if (!button) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updateActivitiesButton();
    });
    observer.observe(button, {attributeFilter: ['aria-pressed']});
    this.#updateActivitiesButton();
  }

  /**
   * Setup the meeting room presenting state button.
   */
  #setupPresentingButton() {
    const presentationBar = this.#getPresentationBar();
    if (!presentationBar) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updatePresentingButton();
    });
    observer.observe(presentationBar, {childList: true});
    this.#updatePresentingButton();
  }

  /**
   * Setup the meeting room send a reaction button.
   */
  #setupReactionButton() {
    const button = this.#getReactionButton();
    if (!button) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updateReactionButton();
    });
    observer.observe(button, {attributeFilter: ['aria-pressed']});
    this.#updateReactionButton();
  }

  /**
   * Setup the green room mic button.
   */
  #setupGreenRoomMicButton() {
    const button = this.#getGreenRoomMicButton();
    if (!button) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updateGreenRoomMicButton();
    });
    observer.observe(button, {attributeFilter: ['data-is-muted']});
    this.#updateGreenRoomMicButton();
  }

  /**
   * Setup the green room camera button.
   */
  #setupGreenRoomCamButton() {
    const button = this.#getGreenRoomCamButton();
    if (!button) {
      return;
    }
    const observer = new MutationObserver(() => {
      this.#updateGreenRoomCamButton();
    });
    observer.observe(button, {attributeFilter: ['data-is-muted']});
    this.#updateGreenRoomCamButton();
  }


  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Update the StreamDeck buttons based on current state. Will be
   * called by the mutation observers created above.
   *
   */

  /**
   * Update the StreamDeck mic button to indicate current state.
   */
  #updateMicButton() {
    const button = this.#getMicButton();
    if (!button) {
      return;
    }
    const newVal = button.dataset?.isMuted == 'true';
    const img = newVal ? 'mic-disabled' : 'mic';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck camera button to indicate current state.
   */
  #updateCamButton() {
    const button = this.#getCamButton();
    if (!button) {
      return;
    }
    const newVal = button.dataset?.isMuted == 'true';
    const img = newVal ? 'cam-disabled' : 'cam';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck CC button to indicate current state.
   */
  #updateCCButton() {
    const button = this.#getCCButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'cc-on' : 'cc';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck hand button to indicate current state.
   */
  #updateHandButton() {
    const button = this.#getHandButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'hand-raised' : 'hand';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck info button to indicate current state.
   */
  #updateInfoButton() {
    const button = this.#getInfoButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'info-open' : 'info';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck people button to indicate current state.
   */
  #updatePeopleButton() {
    const button = this.#getPeopleButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'users-open' : 'users';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck chat button to indicate current state.
   */
  #updateChatButton() {
    const button = this.#getChatButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'chat-open' : 'chat';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck activities button to indicate current state.
   */
  #updateActivitiesButton() {
    const button = this.#getActivitiesButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'activities-open' : 'activities';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck stop presenting button to indicate current state.
   */
  #updatePresentingButton() {
    const button = this.#getStopPresentingButton();
    const img = button ? 'present-stop' : 'blank';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck Send a Reaction button to indicate current state.
   */
  #updateReactionButton() {
    const button = this.#getReactionButton();
    if (!button) {
      return;
    }
    const newVal = this.#isToggled(button);
    const img = newVal ? 'reaction-open' : 'reaction';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck mic button (green room) to indicate current state.
   */
  #updateGreenRoomMicButton() {
    const button = this.#getGreenRoomMicButton();
    if (!button) {
      return;
    }
    const newVal = button.dataset?.isMuted == 'true';
    const img = newVal ? 'mic-disabled' : 'mic';
    this.#drawButton(img);
  }

  /**
   * Update the StreamDeck camera button (green room) to indicate current state.
   */
  #updateGreenRoomCamButton() {
    const button = this.#getGreenRoomCamButton();
    if (!button) {
      return;
    }
    const newVal = button.dataset?.isMuted == 'true';
    const img = newVal ? 'cam-disabled' : 'cam';
    this.#drawButton(img);
  }


  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Generic helpers for finding and inspecting Meet UI elements. The
   * redesigned interface dropped many of the old jscontroller wrapper
   * ids, so these fall back to stable, human-readable attributes
   * (aria-label, data-is-muted, data-panel-id) and visible text.
   *
   */

  /**
   * Return the first element matching any of the given CSS selectors,
   * or null. Used to layer new-interface selectors on top of legacy
   * ones so the wrapper keeps working across Meet UI revisions.
   *
   * @param {string[]} selectors Selectors to try, in priority order.
   * @return {?Element}
   */
  #firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        return el;
      }
    }
    return null;
  }

  /**
   * Find a clickable element (button or div[role=button]) whose visible
   * text or aria-label matches one of the given strings.
   *
   * @param {string[]} texts Candidate texts to match (case-insensitive).
   * @return {?Element}
   */
  #findButtonByText(texts) {
    const candidates = document.querySelectorAll(
        'button, [role="button"], [role="menuitem"], [role="tab"]');
    // Two passes so an exact match always wins. In the new UI a wrapper
    // [role=button] can *contain* the target text (e.g. "Rejoin") while the
    // real clickable button is nested inside it; matching by substring on
    // the first element in document order would grab the wrong, outer node.
    const match = (el, exact) => {
      const label = (el.getAttribute('aria-label') || '').trim();
      const text = (el.textContent || '').trim();
      for (const t of texts) {
        if (exact) {
          if (label === t || text === t) {
            return true;
          }
        } else if (label.toLowerCase().includes(t.toLowerCase()) ||
            text.toLowerCase().includes(t.toLowerCase())) {
          return true;
        }
      }
      return false;
    };
    for (const el of candidates) {
      if (match(el, true)) {
        return el;
      }
    }
    for (const el of candidates) {
      if (match(el, false)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Find the clickable control for a side panel by its data-panel-id.
   * In the new interface the id can sit on a wrapper element rather than
   * the clickable one, so resolve to the inner button if needed.
   *
   * @param {string} panelId The data-panel-id value (e.g. "1").
   * @return {?Element}
   */
  #getPanelButton(panelId) {
    // In the new UI the panel id can appear on more than one element: the
    // control-bar toggle (a real button / role=button) AND the side-panel
    // container div. We must return the toggle, so scan every match and
    // prefer the one that is itself clickable; only fall back to digging
    // inside a wrapper if no match is a button on its own.
    const els = document.querySelectorAll(`[data-panel-id="${panelId}"]`);
    let fallback = null;
    for (const el of els) {
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        return el;
      }
      if (!fallback) {
        fallback = el;
      }
    }
    if (fallback) {
      return fallback.querySelector('button, [role="button"]');
    }
    return null;
  }

  /**
   * Determine if a toggle-style control is currently in its "on"/open
   * state. Meet uses either aria-pressed (icon toggles) or
   * aria-expanded (side panel buttons) depending on the control.
   *
   * @param {Element} el
   * @return {boolean}
   */
  #isToggled(el) {
    if (!el) {
      return false;
    }
    return el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('aria-expanded') === 'true';
  }


  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Helpers to get Meet UI elements.
   *
   */

  /**
   * Get the Start Instant Meeting button (lobby).
   *
   * @return {?Element}
   */
  #getStartInstantMeetingButton() {
    return this.#firstMatch([
      '[jsname="CuSyi"]',
      '[aria-label="Start an instant meeting"]',
    ]);
  }

  /**
   * Check if an element is disabled or unusable as an interactive target.
   *
   * @param {?Element} el
   * @return {boolean}
   */
  #isElementDisabled(el) {
    if (!el) {
      return true;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('disabled')) {
      return true;
    }
    if (el.classList && el.classList.contains('is-disabled')) {
      return true;
    }
    // Reject buttons inside the "Enter a code or nickname" input field container.
    if (el.closest && el.closest(
        '.UvuAre, [jsname="YPqjbf"], .qdOxv-fmcmS-wGMbrd-sM5MNb')) {
      return true;
    }
    return false;
  }

  /**
   * Find the "Past" meetings section in the lobby.
   *
   * @return {?Element}
   */
  #getPastMeetingSection() {
    const known = document.querySelector('section[jsname="IFO1Jf"]');
    if (known) {
      return known;
    }
    for (const section of document.querySelectorAll('section, [role="region"]')) {
      const heading = section.querySelector(
          '[role="heading"], h1, h2, h3, h4, h5, h6');
      if (heading && /^\s*past\b/i.test(heading.textContent || '')) {
        return section;
      }
    }
    return null;
  }

  /**
   * Find the "Scheduled" / upcoming meetings section in the lobby.
   *
   * @return {?Element}
   */
  #getScheduledMeetingSection() {
    // 1) Known jsname for the Scheduled section.
    const known = document.querySelector('section[jsname="n39Uf"]');
    if (known) {
      return known;
    }

    // 2) Search by heading text across sections / regions.
    const pastSection = this.#getPastMeetingSection();
    for (const section of document.querySelectorAll('section, [role="region"]')) {
      if (section === pastSection) {
        continue;
      }
      const heading = section.querySelector(
          '[role="heading"], h1, h2, h3, h4, h5, h6');
      if (heading && /scheduled|upcoming|today/i.test(heading.textContent || '')) {
        return section;
      }
    }

    // 3) Fallback: any section containing meeting cards that isn't the past section.
    for (const section of document.querySelectorAll('section, [role="region"]')) {
      if (section === pastSection) {
        continue;
      }
      if (section.querySelector(
          '[data-unused-time], [data-unused-title], [data-focus-priority], [jscontroller="GxOwhc"]')) {
        return section;
      }
    }

    return null;
  }

  /**
   * Extracts the actual clickable / interactive element from a meeting card.
   * Works across Material 3 cards, native buttons, and custom wrappers.
   *
   * @param {!Element} card A meeting card container or element.
   * @return {!Element} The clickable element (or the card itself).
   */
  #extractInteractiveCardElement(card) {
    if (!card) {
      return null;
    }

    // 1) If the card element itself is an interactive button or has focus priority:
    if ((card.tagName === 'BUTTON' || card.getAttribute('role') === 'button' ||
         card.hasAttribute('data-focus-priority')) &&
        !this.#isElementDisabled(card)) {
      return card;
    }

    // 2) Look for Google's a11y focus-priority element inside the card.
    const priority = card.querySelector(
        '[data-focus-priority="1"], [data-focus-priority], [data-default-focus="true"]');
    if (priority && !this.#isElementDisabled(priority)) {
      return priority;
    }

    // 3) Material or ARIA button inside the card.
    const btn = card.querySelector(
        'button:not([disabled]), [role="button"]:not([aria-disabled="true"]):not([disabled])');
    if (btn && !this.#isElementDisabled(btn)) {
      return btn;
    }

    // 4) Google WIZ jsaction parameter target (e.g. JIbuQc:oRCNsf(Dq2Egc) -> jsname="Dq2Egc").
    const actionEl = card.hasAttribute('jsaction') ?
        card : card.querySelector('[jsaction*="("]');
    if (actionEl) {
      const match = (actionEl.getAttribute('jsaction') || '').match(/\(([^)]+)\)/);
      if (match) {
        const target = card.querySelector(`[jsname="${match[1]}"]`);
        if (target) {
          const innerBtn = target.querySelector(
              'button, [role="button"]') || target;
          if (!this.#isElementDisabled(innerBtn)) {
            return innerBtn;
          }
        }
      }
    }

    // 5) data-unused-join label span target (historical).
    const joinMarker = card.querySelector('[data-unused-join]');
    if (joinMarker) {
      const labelId = joinMarker.getAttribute('data-unused-join');
      const labelEl = labelId ? document.getElementById(labelId) : null;
      if (labelEl) {
        const b = labelEl.closest(
            'button, [role="button"], [class*="VfPpkd"]');
        if (b && !this.#isElementDisabled(b)) {
          return b;
        }
      }
    }

    // 6) Any focusable element or link.
    const focusable = card.querySelector(
        '[tabindex="0"]:not([disabled]), a[href]:not([disabled])');
    if (focusable && !this.#isElementDisabled(focusable)) {
      return focusable;
    }

    // 7) Only return card itself if it has an explicit click jsaction or button-like role.
    const hasClickAction = /click:/i.test(card.getAttribute('jsaction') || '');
    if ((hasClickAction || card.getAttribute('role') === 'button') &&
        !this.#isElementDisabled(card)) {
      return card;
    }

    return null;
  }

  /**
   * Get the Start Next Meeting button (lobby).
   *
   * Employs multiple resilient strategies so it will not break across
   * Google Meet updates, re-minified class names, or DOM restructurings:
   * 1. Direct a11y focus priority marker (data-focus-priority="1")
   * 2. Scheduled section first card interactive element
   * 3. Meeting card metadata markers (data-unused-time/title/join)
   * 4. Meeting time-range heuristic
   * 5. Visible, enabled Join button (excluding code-entry inputs)
   *
   * @return {?Element}
   */
  #getStartNextMeetingButton() {
    const pastSection = this.#getPastMeetingSection();
    const isInPast = (el) => pastSection && (pastSection === el || pastSection.contains(el));

    // Strategy 1: Google Meet's focus priority attribute.
    // The lobby marks the next upcoming meeting with data-focus-priority="1"
    // (legacy: data-default-focus="true").
    const priorityCandidates = Array.from(
        document.querySelectorAll(
            '[data-focus-priority], [data-default-focus="true"]'))
        .filter((el) => !isInPast(el) && !this.#isElementDisabled(el));
    if (priorityCandidates.length) {
      // Pick the lowest numeric priority (1 is highest priority).
      priorityCandidates.sort((a, b) => {
        const pa = parseInt(a.getAttribute('data-focus-priority') || '999', 10);
        const pb = parseInt(b.getAttribute('data-focus-priority') || '999', 10);
        return pa - pb;
      });
      const target = this.#extractInteractiveCardElement(priorityCandidates[0]);
      if (target && !this.#isElementDisabled(target)) {
        return target;
      }
    }

    // Strategy 2: First card inside the "Scheduled" section.
    const scheduledSection = this.#getScheduledMeetingSection();
    if (scheduledSection) {
      const card = scheduledSection.querySelector(
          'ol > li, ul > li, [role="listitem"], [jscontroller="GxOwhc"], [jscontroller="fhtj7"]');
      if (card) {
        const target = this.#extractInteractiveCardElement(card);
        if (target && !this.#isElementDisabled(target)) {
          return target;
        }
      }
    }

    // Strategy 3: Meeting metadata markers (data-unused-time, data-unused-title, data-unused-join).
    for (const marker of document.querySelectorAll(
        '[data-unused-time], [data-unused-title], [data-unused-join]')) {
      if (isInPast(marker)) {
        continue;
      }
      const card = marker.closest(
          'li, [role="listitem"], [jscontroller="GxOwhc"], [jscontroller="fhtj7"]') ||
          marker.parentElement;
      if (card) {
        const target = this.#extractInteractiveCardElement(card);
        if (target && !this.#isElementDisabled(target)) {
          return target;
        }
      }
    }

    // Strategy 4: Meeting time range heuristic (e.g. "11:30 AM – 12:30 PM").
    // Matches time ranges while ignoring the mini-calendar picker.
    const timeRegex = /\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?\s*[\u2013\u2014-]\s*\d{1,2}:\d{2}/;
    for (const el of document.querySelectorAll('span, div, p')) {
      if (isInPast(el) ||
          (el.closest && el.closest(
              '[role="grid"], .pYTkkf-Bz112c-LgbsSe, [jsname="cLCH8"]'))) {
        continue;
      }
      if (el.children.length === 0 && timeRegex.test(el.textContent || '')) {
        const card = el.closest(
            'li, [role="listitem"], [jscontroller="GxOwhc"], [jscontroller="fhtj7"]') ||
            el.parentElement;
        if (card) {
          const target = this.#extractInteractiveCardElement(card);
          if (target && !this.#isElementDisabled(target)) {
            return target;
          }
        }
      }
    }

    // Strategy 5: Visible, enabled Join button (guarded against code-input Join buttons).
    const joinCandidates = document.querySelectorAll('button, [role="button"]');
    for (const btn of joinCandidates) {
      if (this.#isElementDisabled(btn) || isInPast(btn)) {
        continue;
      }
      const label = (btn.getAttribute('aria-label') || '').trim();
      const text = (btn.textContent || '').trim();
      const isJoinText = /^(join|join now|start)$/i.test(text) ||
          /^(join|join now|start)\b/i.test(label);
      if (isJoinText) {
        const isVisible = btn.checkVisibility ?
            btn.checkVisibility() : btn.offsetParent !== null;
        if (isVisible) {
          return btn;
        }
      }
    }

    return null;
  }

  /**
   * Get all meeting cards in the lobby, in visual top-to-bottom order:
   * past meetings first (up), then upcoming/scheduled meetings (down/future).
   * Used by previous/next navigation to move a highlight between meetings.
   *
   * @return {!Element[]} Card container elements.
   */
  #getLobbyMeetingCards() {
    const cards = [];
    const push = (el) => {
      if (!el) {
        return;
      }
      const outer = el.closest('li, [role="listitem"]') || el;
      if (!cards.some(
          (existing) => existing === outer ||
          existing.contains(outer) || outer.contains(existing))) {
        cards.push(outer);
      }
    };

    // Past meetings first (top of screen / into the past):
    const pastSection = this.#getPastMeetingSection();
    if (pastSection) {
      for (const card of pastSection.querySelectorAll(
          'ol > li, ul > li, [role="listitem"], [jscontroller="fhtj7"], [jscontroller="GxOwhc"]')) {
        push(card);
      }
    }

    // Upcoming/scheduled meetings (below past / down into future):
    const scheduledSection = this.#getScheduledMeetingSection();
    if (scheduledSection) {
      for (const card of scheduledSection.querySelectorAll(
          'ol > li, ul > li, [role="listitem"], [jscontroller="GxOwhc"], [jscontroller="fhtj7"]')) {
        push(card);
      }
    }
    for (const marker of document.querySelectorAll(
        '[data-unused-time], [data-unused-title], [data-unused-join]')) {
      if (pastSection && pastSection.contains(marker)) {
        continue;
      }
      push(marker.closest(
          'li, [role="listitem"], [jscontroller="GxOwhc"], [jscontroller="fhtj7"]'));
    }

    return cards;
  }

  /**
   * Determine the default highlighted card index when entering the lobby.
   * Prefers the next/current scheduled meeting card so 'start-next'
   * targets it immediately unless the user navigates.
   *
   * @param {!Element[]} cards Array of lobby meeting cards.
   * @return {number} Index in cards.
   */
  #getInitialLobbyHighlightIndex(cards) {
    if (!cards || !cards.length) {
      return 0;
    }
    const nextBtn = this.#getStartNextMeetingButton();
    if (nextBtn) {
      const idx = cards.findIndex(
          (card) => card === nextBtn || card.contains(nextBtn));
      if (idx !== -1) {
        return idx;
      }
    }
    const scheduledSection = this.#getScheduledMeetingSection();
    if (scheduledSection) {
      const idx = cards.findIndex((card) => scheduledSection.contains(card));
      if (idx !== -1) {
        return idx;
      }
    }
    return 0;
  }

  /**
   * The meeting card at the current lobby highlight index, if any.
   *
   * @return {?Element}
   */
  #getHighlightedLobbyCard() {
    const cards = this.#getLobbyMeetingCards();
    if (!cards.length) {
      return null;
    }
    return cards[this.#lobbyHighlightIndex % cards.length] || null;
  }

  /**
   * The card's actually-interactive element: for joinable meetings the
   * inner button / role=button, otherwise the card wrapper itself.
   *
   * @param {!Element} card A meeting card container.
   * @return {!Element}
   */
  #getLobbyCardInteractiveElement(card) {
    return this.#extractInteractiveCardElement(card) || card;
  }

  /**
   * Shows the visible highlight ring on the given card.
   *
   * @param {?Element} card
   */
  #setLobbyHighlightRing(card) {
    for (const el of document.querySelectorAll('[data-sd-meet-highlight]')) {
      el.removeAttribute('data-sd-meet-highlight');
      el.style.boxShadow = '';
      el.style.outline = '';
      el.style.borderRadius = '';
    }
    if (card) {
      card.setAttribute('data-sd-meet-highlight', '1');
      card.style.boxShadow = '0 0 0 3px #8ab4f8';
      card.style.outline = '2px solid #8ab4f8';
      card.style.borderRadius = '8px';
    }
  }

  /**
   * TEMPORARILY DISABLED: replaced by the tab/select lobby keys (see
   * #enterLobby and #handleStreamDeckPress). Kept for reference.
   *
   * Get the clickable element for the most recent *past* meeting (lobby).
   *
   * @return {?Element}
   */
  #getJoinPreviousMeetingButton() {
    const pastSection = this.#getPastMeetingSection();
    if (!pastSection) {
      return null;
    }

    let cards = pastSection.querySelectorAll(
        'ol > li, ul > li, [role="listitem"], [jscontroller="fhtj7"], [jscontroller="GxOwhc"]');
    if (!cards.length) {
      return null;
    }
    const card = cards[cards.length - 1];
    return this.#extractInteractiveCardElement(card) || card;
  }

  /**
   * Get the Join Meeting button (green room).
   *
   * @return {?Element}
   */
  #getEnterMeetingButton() {
    // In the new green room the join control is a div[role=button].
    const button = this.#findButtonByText(['Join now', 'Join without camera', 'Join with camera']);
    if (button) {
      return button;
    }
    return document.querySelector('[class=UywwFc-vQzf8d]');
  }

  /**
   * Get the Meeting Info dialog shown for instant meetings (meeting).
   *
   * @return {?Element}
   */
  #getMeetingInfoDialog() {
    return document.querySelector('[jscontroller=Cmkwqf]');
  }

  /**
   * Get the close button for the Meeting Info dialog (meeting).
   *
   * @return {?Element}
   */
  #getMeetingInfoDialogCloseButton() {
    const dialog = document.querySelector('[jscontroller=Cmkwqf]');
    if (dialog) {
      return dialog.querySelector('[aria-label=Close]');
    }
  }

  /**
   * Get the presentation bar container (meeting).
   *
   * @return {?Element}
   */
  #getPresentationBar() {
    return document.querySelector('[jscontroller=E9nYD]');
  }

  /**
   * Get the Mic button in the meeting room.
   *
   * @return {?Element}
   */
  #getMicButton() {
    // In the new UI hw0c9 is the clickable div[role=button] itself, and
    // it carries data-is-muted directly. The legacy layout wrapped it in
    // an eB6kvd container with a nested button.
    return this.#firstMatch([
      '[jsname="hw0c9"]',
      '[jscontroller="eB6kvd"] button[data-is-muted]',
      '[role="button"][aria-label*="microphone"]',
    ]);
  }

  /**
   * Get the Camera button in the meeting room.
   *
   * @return {?Element}
   */
  #getCamButton() {
    // Same story as the mic button: psRWwc is the clickable element
    // itself in the new UI, with data-is-muted on it.
    return this.#firstMatch([
      '[jsname="psRWwc"]',
      '[jscontroller="bwqwSd"] button[data-is-muted]',
      '[role="button"][aria-label*="camera"]',
    ]);
  }

  /**
   * Get the CC button in the meeting room.
   *
   * @return {?Element}
   */
  #getCCButton() {
    // RrG0hf is the clickable div[role=button] in the new UI.
    return this.#firstMatch([
      '[jsname="RrG0hf"]',
      '[jscontroller="iBwifb"] button',
      '[aria-label*="captions"]',
    ]);
  }

  /**
   * Get the Raise Hand button in the meeting room.
   *
   * @return {?Element}
   */
  #getHandButton() {
    const sel = '[jscontroller=LtjzW]';
    return document.querySelector(sel)?.querySelector('button');
  }

  /**
   * Get the Stop Presenting button in the meeting room.
   *
   * @return {?Element}
   */
  #getStopPresentingButton() {
    return this.#firstMatch([
      '[jsname="aK5XXd"]',
      '[aria-label="Stop sharing"]',
    ]);
  }

  /**
   * Get the Info button in the meeting room.
   *
   * @return {?Element}
   */
  #getInfoButton() {
    // In the new UI data-panel-id sits on a wrapper div, not the button.
    return this.#getPanelButton('5') ?? document.querySelector('button[data-panel-id="5"]');
  }

  /**
   * Get the People button in the meeting room.
   *
   * @return {?Element}
   */
  #getPeopleButton() {
    // data-panel-id="1" was already missing in the pre-redesign UI, so
    // this is best-effort: prefer the panel attribute, then the label.
    return this.#getPanelButton('1') ?? this.#findButtonByText(['People']);
  }

  /**
   * Get the Chat button in the meeting room.
   *
   * @return {?Element}
   */
  #getChatButton() {
    return this.#getPanelButton('2') ?? document.querySelector('button[data-panel-id="2"]');
  }

  /**
   * Get the Activities button in the meeting room.
   *
   * @return {?Element}
   */
  #getActivitiesButton() {
    return this.#getPanelButton('10') ?? document.querySelector('button[data-panel-id="10"]');
  }

  /**
   * Gets the Send a reaction button in the meeting room.
   *
   * @return {?Element}
   */
  #getReactionButton() {
    return this.#firstMatch([
      '[jscontroller="M3NJxf"] button',
      '[jscontroller="M3NJxf"] [role="button"]',
      '[aria-label="Send a reaction"]',
    ]);
  }

  /**
   * Gets the Send a reaction bar in the meeting room.
   *
   * @return {?Element}
   */
  #getReactionBar() {
    const sel = '[jscontroller=tdX73b]';
    return document.querySelector(sel);
  }

  /**
   * Gets the send a reaction emoji button in the meeting room.
   *
   * @param {string} emoji Emoji to find
   * @return {?Element}
   */
  #getReactionEmojiButton(emoji) {
    const sel = `[aria-label=${emoji}]`;
    return document.querySelector(sel);
  }

  /**
   * Get the Hang Up button in the meeting room.
   *
   * @return {?Element}
   */
  #getHangupButton() {
    return this.#firstMatch([
      '[jscontroller="m1IMT"] button',
      '[aria-label="Leave call"]',
      '[aria-label="End call for everyone"]',
    ]);
  }

  /**
   * Get the Mic button in the green room.
   *
   * @return {?Element}
   */
  #getGreenRoomMicButton() {
    // The green room reuses the same control as the meeting room.
    return this.#firstMatch([
      '[jsname="hw0c9"]',
      '[jscontroller="t2mBxb"] [role="button"]',
      '[role="button"][aria-label*="microphone"]',
    ]);
  }

  /**
   * Get the Camera button in the green room.
   *
   * @return {?Element}
   */
  #getGreenRoomCamButton() {
    // The green room reuses the same control as the meeting room.
    return this.#firstMatch([
      '[jsname="psRWwc"]',
      '[jscontroller="bwqwSd"] [role="button"]',
      '[role="button"][aria-label*="camera"]',
    ]);
  }

  /**
   * Get the Rejoin Meeting button in the exit hall.
   *
   * @return {?Element}
   */
  #getRejoinButton() {
    // The oI7Fj wrapper is gone in the new UI, so match by label first.
    return this.#findButtonByText(['Rejoin']) ?? document.querySelector('[jsname="oI7Fj"] button');
  }

  /**
   * Get the Return to Home button in the exit hall.
   *
   * @return {?Element}
   */
  #getReturnToHomeButton() {
    const sel = '[jsname=WIVZEd] button';
    return document.querySelector(sel);
  }

  /* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
   *
   * Helpers to interact with Meet UI elements.
   *
   */

  /**
   * Wrapper for clicking on a button with logging if the button cannot be
   * found. Dispatches pointer events for non-button interactive elements
   * (e.g. Material 3 cards/div[role="button"]) before clicking.
   *
   * @param {Element} button Button to click
   * @param {?String} buttName Name of button (used for logging only)
   */
  #tapButtonWrapper(button, buttName) {
    if (button) {
      try {
        button.focus();
      } catch (ex) {
        // Not focusable.
      }
      if (button.tagName !== 'BUTTON') {
        const opts = {bubbles: true, cancelable: true, view: window};
        button.dispatchEvent(new PointerEvent('pointerover', opts));
        button.dispatchEvent(new PointerEvent('pointerdown', opts));
        button.dispatchEvent(new MouseEvent('mousedown', opts));
        button.dispatchEvent(new PointerEvent('pointerup', opts));
        button.dispatchEvent(new MouseEvent('mouseup', opts));
      }
      button.click();
      return;
    }
    console.warn('*SD-Meet*', `Unable to find/click button '${buttName}'`);
  }

  /**
   * Toggles the tab between full screen and regular.
   */
  async #toggleFullScreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.body.requestFullscreen();
      }
    } catch (ex) {
      // Cannot do fullscreen, disable the button.
      this.#drawButton(`fullscreen-disabled`);
    }
  }

  /**
   * Starts an instant meeting (lobby).
   */
  #tapStartInstantMeeting() {
    const button = this.#getStartInstantMeetingButton();
    this.#tapButtonWrapper(button, 'startInstant');
  }

  /**
   * Starts or joins the currently highlighted meeting (or the next upcoming
   * meeting if no cards have been explicitly navigated).
   */
  #tapStartNextMeeting() {
    let target = null;
    const cards = this.#getLobbyMeetingCards();
    if (cards.length > 0) {
      if (!this.#lobbyHighlightTouched) {
        this.#lobbyHighlightIndex = this.#getInitialLobbyHighlightIndex(cards);
      }
      const card = cards[this.#lobbyHighlightIndex % cards.length];
      if (card) {
        target = this.#getLobbyCardInteractiveElement(card);
      }
    }
    if (!target) {
      target = this.#getStartNextMeetingButton();
    }
    if (!target) {
      console.warn('*SD-Meet*', 'Unable to find startNext button or highlighted card');
      return;
    }

    const stillInLobby = () =>
        this.#currentRoom === this.#ROOM_NAMES.lobby && target.isConnected;

    this.#tapButtonWrapper(target, 'startNext');

    setTimeout(() => {
      if (!stillInLobby()) {
        return;
      }
      this.#robustClick(target);
    }, 500);

    setTimeout(() => {
      if (!stillInLobby()) {
        return;
      }
      const jsh = target.getAttribute('data-jsh') || '';
      const action = target.getAttribute('jsaction') || '';
      const jshMap = {};
      for (const part of jsh.split(';')) {
        const [key, val] = part.split(':');
        if (key && val) {
          jshMap[key] = val;
        }
      }
      for (const pair of action.split(';')) {
        const [event, name] = pair.split(':');
        if (event === 'click' && name) {
          const internal = jshMap[name];
          if (internal && typeof window[internal] === 'function') {
            try {
              window[internal](target, {});
            } catch (ex) {
              console.warn('*SD-Meet*', `jsaction ${internal} threw:`, ex);
            }
          }
        }
      }
    }, 1200);

    setTimeout(() => {
      if (!stillInLobby()) {
        return;
      }
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    }, 1900);
  }

  /**
   * Moves the lobby highlight up or into the past (wraps around).
   * Highlights the card with a blue ring and focuses its interactive element.
   */
  #tapLobbyPrevious() {
    const cards = this.#getLobbyMeetingCards();
    if (!cards.length) {
      console.warn('*SD-Meet*', 'No meeting cards found in lobby');
      return;
    }
    if (!this.#lobbyHighlightTouched) {
      this.#lobbyHighlightIndex = this.#getInitialLobbyHighlightIndex(cards);
    }
    this.#lobbyHighlightIndex =
        (this.#lobbyHighlightIndex - 1 + cards.length) % cards.length;
    this.#lobbyHighlightTouched = true;
    const card = cards[this.#lobbyHighlightIndex];
    const label = (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    console.log('*SD-Meet*', `Lobby previous ${this.#lobbyHighlightIndex + 1}/${cards.length}: "${label}"`);
    this.#setLobbyHighlightRing(card);
    try {
      this.#getLobbyCardInteractiveElement(card).focus();
    } catch (ex) {
      // Not focusable; the ring still marks the highlight.
    }
  }

  /**
   * Moves the lobby highlight down or into the future (wraps around).
   * Highlights the card with a blue ring and focuses its interactive element.
   */
  #tapLobbyNext() {
    const cards = this.#getLobbyMeetingCards();
    if (!cards.length) {
      console.warn('*SD-Meet*', 'No meeting cards found in lobby');
      return;
    }
    if (!this.#lobbyHighlightTouched) {
      this.#lobbyHighlightIndex = this.#getInitialLobbyHighlightIndex(cards);
    }
    this.#lobbyHighlightIndex = (this.#lobbyHighlightIndex + 1) % cards.length;
    this.#lobbyHighlightTouched = true;
    const card = cards[this.#lobbyHighlightIndex];
    const label = (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    console.log('*SD-Meet*', `Lobby next ${this.#lobbyHighlightIndex + 1}/${cards.length}: "${label}"`);
    this.#setLobbyHighlightRing(card);
    try {
      this.#getLobbyCardInteractiveElement(card).focus();
    } catch (ex) {
      // Not focusable; the ring still marks the highlight.
    }
  }

  /**
   * Taps the mic button, to mute/unmute the mic (green room).
   */
  #tapGreenRoomMic() {
    const button = this.#getGreenRoomMicButton();
    this.#tapButtonWrapper(button, 'greenMic');
  }

  /**
   * Taps the camera button, to mute/unmute the camera (green room).
   */
  #tapGreenRoomCam() {
    const button = this.#getGreenRoomCamButton();
    this.#tapButtonWrapper(button, 'greenCam');
  }

  /**
   * Enter/join meeting (green room).
   */
  #tapEnterMeeting() {
    const button = this.#getEnterMeetingButton();
    this.#tapButtonWrapper(button, 'enterMeeting');
  }

  /**
   * Taps the mic button to mute/unmute (meeting room).
   */
  #tapMic() {
    const button = this.#getMicButton();
    this.#tapButtonWrapper(button, 'micOnOff');
  }

  /**
   * Taps the camera button, to mute/unmute (meeting room).
   */
  #tapCam() {
    const button = this.#getCamButton();
    this.#tapButtonWrapper(button, 'camOnOff');
  }

  /**
   * Taps the handup button, to toggle the hand state (meeting room).
   */
  #tapHand() {
    const button = this.#getHandButton();
    this.#tapButtonWrapper(button, 'hand');
  }

  /**
   * Taps the CC button, to toggle the captions (meeting room).
   */
  #tapCC() {
    const button = this.#getCCButton();
    this.#tapButtonWrapper(button, 'cc');
  }

  /**
   * Taps the Info button, to toggle info panel (meeting room).
   */
  #tapInfo() {
    const button = this.#getInfoButton();
    this.#tapButtonWrapper(button, 'info');
  }

  /**
   * Taps the Users button, to toggle the list of users (meeting room).
   */
  #tapUsers() {
    const button = this.#getPeopleButton();
    this.#tapButtonWrapper(button, 'people');
  }

  /**
   * Taps the Chat button, to toggle the chat panel (meeting room).
   */
  #tapChat() {
    const button = this.#getChatButton();
    this.#tapButtonWrapper(button, 'chat');
  }

  /**
   * Taps the Activities button, to toggle activities panel (meeting room).
   */
  #tapActivities() {
    const button = this.#getActivitiesButton();
    this.#tapButtonWrapper(button, 'activities');
  }

  /**
   * Taps the Send a reaction button, to toggle reaction panel (meeting room).
   */
  #tapReactions() {
    const button = this.#getReactionButton();
    this.#tapButtonWrapper(button, 'reactions');
  }

  /**
   * Get the "More options" (three-dot) menu in the bottom control bar.
   *
   * The video feed also has a "More options" button on every participant
   * tile, so taking the first match in document order lands on a tile menu
   * (which has no "Adjust view" item). We anchor on the hang-up button, which
   * only exists in the control bar, and walk up to the nearest ancestor that
   * also holds a "More options" button — that ancestor is the control bar.
   *
   * @return {?Element}
   */
  #getMoreOptionsMenu() {
    const hangup = document.querySelector(
        '[aria-label="Leave call"], [aria-label="End call for everyone"]');
    if (hangup) {
      let el = hangup.parentElement;
      while (el && el !== document.body) {
        const more = el.querySelector('[aria-label*="More options"]');
        if (more) {
          return more;
        }
        el = el.parentElement;
      }
    }
    // Fallback if the hang-up button isn't present.
    return document.querySelector('[aria-label*="More options"]');
  }

  /**
   * Find a clickable item in the currently-open menu/panel. Searches the
   * most recently opened menu container first (last in document order), so
   * items with the same text in other open menus (e.g. a participant tile's
   * "Spotlight") can't be matched by mistake. Falls back to the whole
   * document if no menu container is found.
   *
   * @param {string[]} texts Candidate texts to match.
   * @return {?Element}
   */
  #findOpenMenuItem(texts) {
    const isVisible = (el) =>
        (el.checkVisibility ? el.checkVisibility() :
            el.offsetParent !== null || el.getClientRects().length > 0);
    const menus = Array.from(document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="dialog"], [role="presentation"]'))
        .filter(isVisible);

    const searchIn = (scope) => {
      const candidates = scope.querySelectorAll(
          'button, [role="button"], [role="menuitem"], [role="menuitemradio"], ' +
          '[role="option"], [role="tab"], [role="radio"], [role="switch"], ' +
          'input[type="radio"], input[type="checkbox"], label');
      // Exact match first.
      for (const el of candidates) {
        const label = (el.getAttribute('aria-label') || '').trim();
        const text = (el.textContent || '').trim();
        for (const t of texts) {
          if (label === t || text === t) {
            return el;
          }
        }
      }
      // Then substring.
      for (const el of candidates) {
        const label = (el.getAttribute('aria-label') || '').trim();
        const text = (el.textContent || '').trim();
        for (const t of texts) {
          if (label.toLowerCase().includes(t.toLowerCase()) ||
              text.toLowerCase().includes(t.toLowerCase())) {
            return el;
          }
        }
      }
      return null;
    };

    // Prefer the most recently opened menu (last in document order) so an
    // identically-named item in another open menu can't be matched. If that
    // scope has nothing, fall back to the whole document.
    if (menus.length) {
      const el = searchIn(menus[menus.length - 1]);
      if (el) {
        return el;
      }
    }
    return searchIn(document);
  }

  /**
   * Repeatedly try to find an open-menu item while it renders.
   *
   * @param {string[]} texts Candidate texts to match.
   * @param {number} attempts Max number of polls.
   * @param {number} intervalMs Delay between polls.
   * @param {Function} onFound Called with the found element.
   * @param {Function} onGiveUp Called if nothing was found in time.
   */
  #waitOpenMenuItem(texts, attempts, intervalMs, onFound, onGiveUp) {
    let tries = 0;
    const poll = () => {
      const el = this.#findOpenMenuItem(texts);
      if (el) {
        onFound(el);
        return;
      }
      tries++;
      if (tries >= attempts) {
        onGiveUp();
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  }

  /**
   * Ask the page to close whatever menu/panel is open.
   */
  #dismissOpenMenus() {
    // Some Meet menus listen for Escape on document, others on body or on
    // themselves; dispatch to all three so at least one handler catches it.
    for (const target of [document, document.body]) {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true,
      }));
    }
    // Fallback: toggle any open menu closed via its aria-expanded control.
    const isVisible = (el) =>
        (el.checkVisibility ? el.checkVisibility() :
            el.offsetParent !== null || el.getClientRects().length > 0);
    const menus = Array.from(document.querySelectorAll(
        '[role="menu"], [role="listbox"]')).filter(isVisible);
    for (const m of menus) {
      this.#clickAncestorWithAriaExpanded(m);
    }
  }

  /**
   * All currently visible menu/panel containers, in document order.
   */
  #getVisibleMenus() {
    const isVisible = (el) =>
        (el.checkVisibility ? el.checkVisibility() :
            el.offsetParent !== null || el.getClientRects().length > 0);
    return Array.from(document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="dialog"], [role="presentation"]'))
        .filter(isVisible);
  }

  /**
   * Wait for the "Adjust view" panel to fully close after an option has
   * been selected. Selecting the option does not always dismiss the panel
   * by itself, and letting a new press (or its pre-press Escape) interrupt
   * the panel's close animation used to leave Meet's overlay manager
   * wedged, after which the three-dot menu never opened again. So: send
   * Escape, then poll until no menu/panel is visible any more, and only
   * then call onDone (which clears the busy flag). If the panel refuses
   * to close, toggle the three-dot menu and try once more; onDone is
   * always eventually called so the button can never stay locked out.
   */
  #waitForPanelClosed(moreButton, onDone) {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        onDone();
      }
    };

    setTimeout(() => {
      this.#dismissOpenMenus();
      let tries = 0;
      const poll = () => {
        if (this.#getVisibleMenus().length === 0) {
          finish();
          return;
        }
        tries++;
        if (tries < 15) {
          setTimeout(poll, 150);
          return;
        }
        // Still open: toggle the three-dot menu and Escape once more.
        console.warn('*SD-Meet*', 'Adjust view panel still open, toggling menu closed');
        if (moreButton && moreButton.isConnected) {
          this.#robustClick(moreButton);
        }
        this.#dismissOpenMenus();
        setTimeout(() => {
          if (this.#getVisibleMenus().length > 0) {
            console.warn('*SD-Meet*', 'Adjust view panel would not close');
          }
          finish();
        }, 600);
      };
      setTimeout(poll, 450);
    }, 350);
  }

  /**
   * Click the nearest ancestor of el that has an aria-expanded attribute
   * (the menu toggle button). Used to close a menu by toggling it.
   */
  #clickAncestorWithAriaExpanded(el) {
    let node = el;
    for (let i = 0; i < 12 && node; i++) {
      if (node.getAttribute && node.getAttribute('aria-expanded') !== null) {
        this.#robustClick(node);
        return;
      }
      node = node.parentElement;
    }
  }

  /**
   * Log the visible text of every currently open menu/panel. Used on
   * failure so the console shows exactly what the page rendered.
   */
  #dumpOpenMenus() {
    const isVisible = (el) =>
        (el.checkVisibility ? el.checkVisibility() :
            el.offsetParent !== null || el.getClientRects().length > 0);
    const menus = Array.from(document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="dialog"], ' +
        '[role="presentation"]')).filter(isVisible);
    if (!menus.length) {
      console.warn('*SD-Meet*', 'No open menus/panels found.');
      return;
    }
    for (const m of menus) {
      const role = m.getAttribute('role') || m.tagName.toLowerCase();
      const text = (m.textContent || '').replace(/\s+/g, ' ').trim();
      console.warn(`*SD-Meet* Open ${role}: "${text.slice(0, 600)}"`);
    }
  }

  /**
   * "Poke" the control bar so auto-hide reveals it. Meet fades the control
   * bar out after a few seconds of mouse inactivity; since the Stream Deck
   * never moves the mouse, the bar is usually hidden by the time a button
   * is pressed. A synthetic mouse move over the bar (dispatched on document
   * so it hit-tests like a real one) restarts the auto-hide timer and makes
   * the bar's buttons clickable again.
   */
  #pokeControlBar(el) {
    const rect = el.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return;
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {bubbles: true, cancelable: true, view: window, clientX: x, clientY: y};
    document.dispatchEvent(new PointerEvent('pointermove', opts));
    document.dispatchEvent(new MouseEvent('mousemove', opts));
  }

  /**
   * Click an element with the full pointer/mouse event sequence. Some
   * Material UI components only react to a real-looking click, not a
   * bare el.click().
   */
  #robustClick(el) {
    const opts = {bubbles: true, cancelable: true, view: window};
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', {
      bubbles: false, cancelable: false, view: window,
    }));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  /**
   * TEMPORARILY DISABLED: the button is no longer drawn or wired up (see
   * #enterMeeting and #handleStreamDeckPress). The implementation below is
   * kept for a future revisit. Known remaining issue: after the first
   * successful selection, subsequent clicks on the three-dot menu button
   * do not open the menu; the leading suspect is Meet's control-bar
   * auto-hide (see #pokeControlBar), which the synthetic mouse-move poke
   * did not fully resolve.
   *
   * Cycles the "Adjust view" option (meeting room). Each press advances to
   * the next option in #ADJUST_VIEW_OPTIONS, opens the three-dot "More
   * options" menu, opens the "Adjust view" submenu, and selects that option.
   * If anything fails, Escape is sent so no panel is left stuck open.
   */
  #tapAdjustView() {
    if (this.#adjustViewBusy) {
      console.warn('*SD-Meet*', 'Adjust view still settling, ignoring press');
      return;
    }
    this.#adjustViewBusy = true;
    const count = this.#ADJUST_VIEW_OPTIONS.length;
    this.#adjustViewIndex = (this.#adjustViewIndex + 1) % count;
    const option = this.#ADJUST_VIEW_OPTIONS[this.#adjustViewIndex];
    console.log('*SD-Meet*', 'Adjust view ->', option);

    const finish = () => {
      this.#adjustViewBusy = false;
    };

    const fail = (what) => {
      console.warn('*SD-Meet*', what);
      this.#dumpOpenMenus();
      // Close the stuck panel so the Stream Deck stays usable, and
      // re-attempt the same option on the next press.
      this.#dismissOpenMenus();
      this.#adjustViewIndex--;
      finish();
    };

    const moreButton = this.#getMoreOptionsMenu();
    if (!moreButton) {
      fail('Unable to find "More options" menu');
      return;
    }
    // If a previous press left a menu/panel open, close it first so this
    // press starts from a clean state.
    this.#dismissOpenMenus();

    const openMenu = (attemptsLeft) => {
      setTimeout(() => {
        // The control bar may have been re-created by a re-render since
        // we resolved the button; re-resolve if it went away.
        const button = moreButton.isConnected ? moreButton :
            this.#getMoreOptionsMenu();
        if (!button) {
          fail('Unable to find "More options" menu');
          return;
        }
        console.log('*SD-Meet*', `Opening more-options menu (attempt ` +
            `${3 - attemptsLeft + 1}/3)`);
        const visible = button.checkVisibility ?
            button.checkVisibility() : button.offsetParent !== null;
        if (!visible) {
          // The control bar is auto-hidden; a hidden bar's menu button
          // won't open its menu, so wake the bar first, then re-resolve
          // (in case the re-render swapped the element) and click.
          console.log('*SD-Meet*', 'More-options button hidden, poking control bar');
          this.#pokeControlBar(button);
          setTimeout(() => {
            const live = button.isConnected ? button :
                this.#getMoreOptionsMenu();
            if (!live) {
              fail('Unable to find "More options" menu');
              return;
            }
            this.#robustClick(live);
            this.#openAdjustViewMenu(live, option, finish, fail, attemptsLeft,
                openMenu);
          }, 250);
          return;
        }
        try {
          button.focus();
        } catch (ex) {
          // Ignore; focus is only a hint.
        }
        this.#robustClick(button);
        this.#openAdjustViewMenu(button, option, finish, fail, attemptsLeft,
            openMenu);
      }, 150);
    };
    openMenu(3);
  }

  /**
   * After the three-dot button has been clicked: wait for the menu to
   * render, open the "Adjust view" submenu, pick the option, then wait for
   * the panel to close before re-arming. Retries the whole open sequence
   * if the menu never appears.
   */
  #openAdjustViewMenu(button, option, finish, fail, attemptsLeft, openMenu) {
    // Wait for the menu to render, then open the "Adjust view" submenu.
    this.#waitOpenMenuItem(['Adjust view'], 15, 100, (el) => {
      this.#robustClick(el);

      // Wait for the adjust-view panel to render, then pick the option.
      this.#waitOpenMenuItem([option], 30, 100, (choice) => {
        this.#robustClick(choice);
        // Only re-arm the button once the panel is confirmed closed;
        // interrupting the close is what used to wedge the menu.
        this.#waitForPanelClosed(button, finish);
      }, () => fail(`Unable to find "Adjust view" option: '${option}'`));
    }, () => {
      if (attemptsLeft > 1) {
        console.warn('*SD-Meet*', 'Menu did not open, retrying');
        this.#dismissOpenMenus();
        setTimeout(() => openMenu(attemptsLeft - 1), 200);
      } else {
        fail('Unable to find "Adjust view" menu item');
      }
    });
  }

  /**
   * Taps the stop presenting button (meeting room).
   */
  #tapStopPresenting() {
    const button = this.#getStopPresentingButton();
    this.#tapButtonWrapper(button, 'stopPresenting');
  }

  /**
   * Taps close button on the meeting info dialog (meeting room).
   */
  #tapCloseInfoDialog() {
    const button = this.#getMeetingInfoDialogCloseButton();
    // We most likely don't care if this isn't open, if it is, close it
    // but no need to log that we couldn't find it.
    if (button) {
      button.click();
    }
  }

  /**
   * Taps the Hang Up button, to end the call (meeting room).
   */
  #tapHangUp() {
    const button = this.#getHangupButton();
    this.#tapButtonWrapper(button, 'hangUp');
  }

  /**
   * Taps the Rejoin button (exit hall).
   */
  #tapRejoin() {
    const button = this.#getRejoinButton();
    this.#tapButtonWrapper(button, 'reJoin');
  }

  /**
   * Taps the Return to Home Screen button (exit hall).
   */
  #tapHome() {
    const button = this.#getReturnToHomeButton();
    this.#tapButtonWrapper(button, 'returnToHome');
  }
}
