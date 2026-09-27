Feature: The app can always tell the user something went wrong

  @finding R1-14 @qa stability: the error banner survives dismissal and keeps reporting
  Scenario: A warning I dismiss does not take the app's ability to warn me with it
    Given two photos in the Library that I have not edited
    And I have selected both of them
    When I press Sync, tick a module and start the sync
    Then I see the warning "Nothing to sync -- the source photo has no edits in the selected modules."
    When I press Escape
    Then the warning is gone
    But the warning area is still in the page, only hidden — not deleted
    When I press Sync, tick a module and start the sync again
    Then I see the warning "Nothing to sync -- the source photo has no edits in the selected modules."
