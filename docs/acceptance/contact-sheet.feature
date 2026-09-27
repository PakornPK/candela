Feature: Contact sheet paging shows the sheet it names

  @finding R1-18 @qa contact sheet: Prev returns to the previous sheet's frames and label
  Scenario: Paging forward then back leaves me exactly where I started
    Given a roll of 80 photos, which the Contact sheet lays out as 3 sheets of 36 frames
    And I am looking at sheet 1: the header reads "Sheet 1 / 3", the frames are numbered 01 to 36, and the previous-sheet button is greyed out
    When I press the next-sheet button
    Then the header reads "Sheet 2 / 3"
    And the frames are a different set of photos than before, numbered from 37
    When I press the previous-sheet button
    Then the header reads "Sheet 1 / 3"
    And the frames are the same photos, in the same order, with the same numbers as before I paged forward
    And the previous-sheet button is greyed out again and the next-sheet button is live

  @finding R1-18 @qa contact sheet: Prev returns to the previous sheet's frames and label
  Scenario: Pressing previous-sheet on the first sheet changes nothing
    Given I am looking at sheet 1 of a 3-sheet roll
    When I press the previous-sheet button twice
    Then the header still reads "Sheet 1 / 3"
    And the frames and their numbers are unchanged — nothing scrolled off the front of the roll
