Feature: Names that came from outside this session reach me as text, never as something the app runs

  @finding R1-3 @qa security: untrusted strings render as text, never as HTML
  Scenario: A smart collection named with markup shows that name, not a broken image
    Given I have photos in the catalog and I am in the Library module
    When I create a smart collection named <img src=x onerror="window.__pwned=1">
    Then I see the text <img src=x onerror="window.__pwned=1"> in the sidebar, not a broken image
    And nothing runs in the page because of that name

  @finding R1-3 @qa security: untrusted strings render as text, never as HTML
  Scenario: A catalog that already holds such a name is still harmless when I reopen the app
    Given the catalog already holds a smart collection named <img src=x onerror="window.__pwned=1">
    When I reload the page
    Then I see the text <img src=x onerror="window.__pwned=1"> in the sidebar, not a broken image
    And nothing runs in the page because of that name

  @finding R1-3 @qa security: untrusted strings render as text, never as HTML
  Scenario: A photo whose name contains markup is still only a name in the loupe read-out
    Given a photo in the catalog is named <img src=x onerror="window.__pwned=2">.jpg
    When I open that photo in Develop and rest the pointer on the top-left corner of the image
    Then the read-out shows the text <img src=x onerror="window.__pwned=2">.jpg
    And nothing runs in the page because of that name
